//! Read the live Windows desktop arrangement without changing Explorer's view.

use std::{collections::HashMap, path::Path};

#[derive(Default)]
pub struct ExplorerLayout {
    positions: HashMap<String, (f64, f64)>,
}

impl ExplorerLayout {
    pub fn position(&self, path: &Path) -> Option<(f64, f64)> {
        self.positions
            .get(&crate::path_security::path_key(path))
            .copied()
    }

    pub fn capture(window: &tauri::WebviewWindow) -> Self {
        #[cfg(target_os = "windows")]
        return match windows_layout::read(window) {
            Ok(positions) => Self { positions },
            Err(error) => {
                eprintln!("DeskChan: couldn't read the Explorer desktop layout: {error}");
                Self::default()
            }
        };
        #[cfg(not(target_os = "windows"))]
        {
            let _ = window;
            Self::default()
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_layout {
    use super::*;
    use crate::win32::{ClientToScreen, ComGuard, Point};
    use std::path::PathBuf;
    use windows::core::Interface;
    use windows::Win32::{
        Foundation::POINT,
        System::Com::{CoCreateInstance, CoTaskMemFree, IServiceProvider, CLSCTX_LOCAL_SERVER},
        System::Variant::VARIANT,
        UI::Shell::{
            Common::ITEMIDLIST, IFolderView, IShellBrowser, IShellFolder, IShellItem,
            IShellWindows, SHCreateItemWithParent, SID_STopLevelBrowser, ShellWindows,
            SIGDN_FILESYSPATH, SVGIO_ALLVIEW, SWC_DESKTOP, SWFO_NEEDDISPATCH,
        },
    };

    fn client_origin(hwnd: isize) -> Option<Point> {
        let mut origin = Point::default();
        (unsafe { ClientToScreen(hwnd, &mut origin) } != 0).then_some(origin)
    }

    pub fn read(window: &tauri::WebviewWindow) -> Result<HashMap<String, (f64, f64)>, String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let overlay = client_origin(hwnd.0 as isize).ok_or("overlay origin unavailable")?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let (origin, positions) = read_native_desktop()?;
        Ok(positions
            .into_iter()
            .map(|(path, point)| {
                (
                    crate::path_security::path_key(&path),
                    to_overlay(point, origin, overlay, scale),
                )
            })
            .collect())
    }

    fn read_native_desktop() -> Result<(Point, Vec<(PathBuf, POINT)>), String> {
        // Explorer owns the desktop IShellView even when its icons are hidden.
        // The shell interfaces return each item's identity and coordinates
        // together, so manual ordering and duplicate display names are safe.
        let _com = ComGuard::init();
        unsafe {
            let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)
                .map_err(|error| error.to_string())?;
            let desktop = VARIANT::default();
            let mut view_handle = 0;
            let dispatch = shell
                .FindWindowSW(
                    &desktop,
                    &desktop,
                    SWC_DESKTOP,
                    &mut view_handle,
                    SWFO_NEEDDISPATCH,
                )
                .map_err(|error| error.to_string())?;
            let services: IServiceProvider = dispatch.cast().map_err(|error| error.to_string())?;
            let browser: IShellBrowser = services
                .QueryService(&SID_STopLevelBrowser)
                .map_err(|error| error.to_string())?;
            let shell_view = browser
                .QueryActiveShellView()
                .map_err(|error| error.to_string())?;
            let view: IFolderView = shell_view.cast().map_err(|error| error.to_string())?;
            let origin = crate::window_manager::desktop_list_view()
                .and_then(client_origin)
                .or_else(|| client_origin(shell_view.GetWindow().ok()?.0 as isize))
                .ok_or("Explorer origin unavailable")?;
            let folder: IShellFolder = view.GetFolder().map_err(|error| error.to_string())?;
            let count = view
                .ItemCount(SVGIO_ALLVIEW)
                .map_err(|error| error.to_string())?;

            let mut positions = Vec::new();
            for index in 0..count {
                let Ok(pidl) = view.Item(index) else { continue };
                let item = position_and_path(&view, &folder, pidl);
                CoTaskMemFree(Some(pidl.cast()));
                if let Some(item) = item {
                    positions.push(item);
                }
            }
            Ok((origin, positions))
        }
    }

    unsafe fn position_and_path(
        view: &IFolderView,
        folder: &IShellFolder,
        pidl: *const ITEMIDLIST,
    ) -> Option<(PathBuf, POINT)> {
        let point = view.GetItemPosition(pidl).ok()?;
        let item: IShellItem = SHCreateItemWithParent(None, folder, pidl).ok()?;
        // Virtual shell shortcuts have a PIDL but no filesystem path and are
        // outside the desktop file catalog used by DeskChan.
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = PathBuf::from(std::ffi::OsString::from_wide(name.as_wide()));
        CoTaskMemFree(Some(name.0.cast()));
        Some((path, point))
    }

    use std::os::windows::ffi::OsStringExt;

    fn to_overlay(point: POINT, origin: Point, overlay: Point, scale: f64) -> (f64, f64) {
        let x = (f64::from(point.x) + f64::from(origin.x) - f64::from(overlay.x)) / scale;
        let y = (f64::from(point.y) + f64::from(origin.y) - f64::from(overlay.y)) / scale;
        // Coordinates are relative to the entire virtual desktop. A saved
        // offscreen position must not become the unplaced sentinel.
        (x.max(0.0), y.max(0.0))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        #[ignore = "requires an interactive Windows Explorer desktop with files"]
        fn reads_live_explorer_positions_for_desktop_files() {
            let (_, points) = read_native_desktop().expect("Explorer desktop view");
            let captured = points
                .iter()
                .map(|(path, _)| crate::path_security::path_key(path))
                .collect::<std::collections::HashSet<_>>();
            let files = crate::desktop::list_entries();
            let matches = files
                .iter()
                .filter(|(path, _)| captured.contains(&crate::path_security::path_key(path)))
                .count();
            assert!(matches > 0, "no filesystem entries matched Explorer");
            assert!(points.iter().any(|(_, point)| point.x != 0 || point.y != 0));
            eprintln!(
                "matched {matches} of {} catalog entries against Explorer coordinates",
                files.len()
            );
        }

        #[test]
        fn keeps_monitor_offsets_before_converting_to_css_pixels() {
            assert_eq!(
                to_overlay(
                    POINT { x: 42, y: 93 },
                    Point { x: -1920, y: 0 },
                    Point { x: -1920, y: -600 },
                    1.5,
                ),
                (28.0, 462.0)
            );
        }
    }
}
