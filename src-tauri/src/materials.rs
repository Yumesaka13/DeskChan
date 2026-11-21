//! Native Fluent material surfaces positioned beneath the desktop WebView.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../bindings/")]
pub enum BackdropMaterial {
    Acrylic,
    Mica,
}

#[derive(Clone, Copy, Debug, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../bindings/")]
pub struct BackdropSurface {
    pub id: u32,
    pub material: BackdropMaterial,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub async fn sync(
    window: tauri::WebviewWindow,
    surfaces: Vec<BackdropSurface>,
    dark: bool,
) -> Result<Vec<u32>, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        let (send, recv) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = send.send(native::sync(hwnd, surfaces, dark));
            })
            .map_err(|error| error.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || recv.recv())
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, surfaces, dark);
        Ok(Vec::new())
    }
}

#[cfg(target_os = "windows")]
pub use native::{align_below, handles};

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use crate::win32::{ClientToScreen, GetWindow, IsWindowVisible, Point, SetWindowPos};
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    use windows::core::{s, w, PCWSTR};
    use windows::Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::{
            Dwm::{
                DwmExtendFrameIntoClientArea, DwmFlush, DwmSetWindowAttribute, DWMSBT_MAINWINDOW,
                DWMWA_BORDER_COLOR, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE,
                DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
            },
            Gdi::{
                BeginPaint, EndPaint, FillRect, GetStockObject, UpdateWindow, BLACK_BRUSH, HBRUSH,
                PAINTSTRUCT,
            },
        },
        System::{
            LibraryLoader::{GetModuleHandleW, GetProcAddress},
            Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
        },
        UI::{
            Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
            Controls::MARGINS,
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetSystemMetrics,
                RegisterClassExW, SystemParametersInfoW, HTTRANSPARENT, SM_REMOTESESSION,
                SPI_GETHIGHCONTRAST, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WM_NCHITTEST, WM_PAINT,
                WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
            },
        },
    };
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    const CLASS: PCWSTR = w!("DeskChanFluentBackdrop");
    const MAX_SURFACES: usize = 272; // 256 fences plus app chrome and submenu levels.
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    const SWP_NOSENDCHANGING: u32 = 0x0400;
    const GW_HWNDNEXT: u32 = 2;
    const NO_BORDER: u32 = 0xfffffffe;
    const PASSTHROUGH_FLAGS: u32 = SWP_NOACTIVATE | SWP_NOSENDCHANGING;

    // HWND creation and destruction live on the Tauri UI thread. The Z-order
    // watchdog reads only a snapshot of the active handles, with no UI locks.
    thread_local! {
        static SURFACES: RefCell<HashMap<u32, NativeSurface>> = RefCell::new(HashMap::new());
        static POLICY: Cell<Option<(Instant, bool)>> = const { Cell::new(None) };
    }
    static ORDER: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    static CLASS_REGISTERED: OnceLock<bool> = OnceLock::new();

    pub fn handles() -> Vec<isize> {
        ORDER
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn align_below(overlay: isize, panes: &[isize]) {
        let mut above = overlay;
        for &pane in panes {
            unsafe {
                if GetWindow(above, GW_HWNDNEXT) != pane || IsWindowVisible(pane) == 0 {
                    SetWindowPos(
                        pane,
                        above,
                        0,
                        0,
                        0,
                        0,
                        PASSTHROUGH_FLAGS | SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW,
                    );
                }
            }
            above = pane;
        }
    }

    struct NativeSurface {
        hwnd: HWND,
        material: BackdropMaterial,
        bounds: Option<RECT>,
        dark: bool,
    }

    impl Drop for NativeSurface {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.hwnd);
            }
        }
    }

    impl NativeSurface {
        fn create(material: BackdropMaterial, dark: bool) -> windows::core::Result<Self> {
            let instance = HINSTANCE(unsafe { GetModuleHandleW(None)? }.0);
            if !*CLASS_REGISTERED.get_or_init(|| register_class(instance)) {
                return Err(windows::core::Error::from_win32());
            }
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT,
                    CLASS,
                    w!(""),
                    WS_POPUP,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    Some(instance),
                    None,
                )?
            };
            let window = Self {
                hwnd,
                material,
                dark,
                bounds: None,
            };
            unsafe {
                // Extend the composition frame over the black client area
                // so DWM paints the system material throughout the surface.
                DwmExtendFrameIntoClientArea(
                    hwnd,
                    &MARGINS {
                        cxLeftWidth: -1,
                        cxRightWidth: -1,
                        cyTopHeight: -1,
                        cyBottomHeight: -1,
                    },
                )?;
                if material == BackdropMaterial::Mica {
                    set_attribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &DWMSBT_MAINWINDOW)?;
                }
                let _ = set_attribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &DWMWCP_ROUND);
                let _ = set_attribute(hwnd, DWMWA_BORDER_COLOR, &NO_BORDER);
            }
            window.apply_theme(dark)?;
            Ok(window)
        }

        fn apply_theme(&self, dark: bool) -> windows::core::Result<()> {
            match self.material {
                BackdropMaterial::Acrylic => apply_acrylic(self.hwnd, dark),
                BackdropMaterial::Mica => unsafe {
                    set_attribute(self.hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &i32::from(dark))
                },
            }
        }

        fn place(&mut self, bounds: RECT, above: isize, dark: bool) -> bool {
            if self.dark != dark {
                let _ = self.apply_theme(dark);
                self.dark = dark;
            }
            let hwnd = self.hwnd.0 as isize;
            if self.bounds == Some(bounds)
                && unsafe { GetWindow(above, GW_HWNDNEXT) == hwnd && IsWindowVisible(hwnd) != 0 }
            {
                return true;
            }
            let placed = unsafe {
                SetWindowPos(
                    hwnd,
                    above,
                    bounds.left,
                    bounds.top,
                    bounds.right - bounds.left,
                    bounds.bottom - bounds.top,
                    PASSTHROUGH_FLAGS | SWP_SHOWWINDOW,
                )
            } != 0;
            if placed {
                self.bounds = Some(bounds);
            }
            placed
        }
    }

    #[repr(C)]
    struct AccentPolicy {
        state: i32,
        flags: i32,
        color: u32,
        animation: i32,
    }

    #[repr(C)]
    struct CompositionAttribute {
        id: i32,
        data: *mut AccentPolicy,
        bytes: usize,
    }

    fn apply_acrylic(hwnd: HWND, dark: bool) -> windows::core::Result<()> {
        // Public system backdrops use the inactive solid color on these
        // non-activating HWNDs. The Acrylic accent path keeps the native
        // blur, luminosity blend, tint, and noise without moving focus.
        const ACCENT_POLICY: i32 = 19;
        const ACRYLIC: i32 = 4;
        type SetCompositionAttribute =
            unsafe extern "system" fn(HWND, *mut CompositionAttribute) -> i32;
        static SET_ATTRIBUTE: OnceLock<Option<SetCompositionAttribute>> = OnceLock::new();
        let apply = SET_ATTRIBUTE
            .get_or_init(|| unsafe {
                let library = GetModuleHandleW(w!("user32.dll")).ok()?;
                let entry = GetProcAddress(library, s!("SetWindowCompositionAttribute"))?;
                Some(std::mem::transmute::<_, SetCompositionAttribute>(entry))
            })
            .ok_or_else(windows::core::Error::from_win32)?;
        let mut accent = AccentPolicy {
            state: ACRYLIC,
            flags: 0,
            color: if dark { 0xa4202020 } else { 0x94fcfcfc }, // ABGR theme tint.
            animation: 0,
        };
        let mut attribute = CompositionAttribute {
            id: ACCENT_POLICY,
            data: &mut accent,
            bytes: size_of::<AccentPolicy>(),
        };
        if unsafe { apply(hwnd, &mut attribute) } != 0 {
            Ok(())
        } else {
            Err(windows::core::Error::from_win32())
        }
    }

    unsafe fn set_attribute<T>(
        hwnd: HWND,
        attribute: windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE,
        value: &T,
    ) -> windows::core::Result<()> {
        DwmSetWindowAttribute(
            hwnd,
            attribute,
            (value as *const T).cast(),
            size_of::<T>() as u32,
        )
    }

    fn register_class(instance: HINSTANCE) -> bool {
        (unsafe {
            RegisterClassExW(&WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                hInstance: instance,
                hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
                lpszClassName: CLASS,
                lpfnWndProc: Some(window_proc),
                ..Default::default()
            })
        }) != 0
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut paint);
                FillRect(dc, &paint.rcPaint, HBRUSH(GetStockObject(BLACK_BRUSH).0));
                let _ = EndPaint(hwnd, &paint);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    fn system_allows_materials() -> bool {
        if windows_version::OsVersion::current().build < 17763 {
            return false;
        }
        let mut contrast = HIGHCONTRASTW {
            cbSize: size_of::<HIGHCONTRASTW>() as u32,
            ..Default::default()
        };
        let mut power = SYSTEM_POWER_STATUS::default();
        unsafe {
            if GetSystemMetrics(SM_REMOTESESSION) != 0
                || (GetSystemPowerStatus(&mut power).is_ok() && power.SystemStatusFlag == 1)
            {
                return false;
            }
            if SystemParametersInfoW(
                SPI_GETHIGHCONTRAST,
                contrast.cbSize,
                Some((&mut contrast as *mut HIGHCONTRASTW).cast::<c_void>()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
            .is_ok()
                && contrast.dwFlags.contains(HCF_HIGHCONTRASTON)
            {
                return false;
            }
        }
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
            .and_then(|key| key.get_value::<u32, _>("EnableTransparency"))
            .unwrap_or(1)
            != 0
    }

    fn allow_materials() -> bool {
        POLICY.with(|policy| {
            if let Some((checked, allowed)) = policy.get() {
                if checked.elapsed().as_millis() < 500 {
                    return allowed;
                }
            }
            let allowed = system_allows_materials();
            policy.set(Some((Instant::now(), allowed)));
            allowed
        })
    }

    fn client_bounds(overlay: isize) -> Option<(RECT, Point)> {
        let mut rect = RECT::default();
        let mut origin = Point::default();
        unsafe { GetClientRect(HWND(overlay as *mut c_void), &mut rect).ok()? };
        (unsafe { ClientToScreen(overlay, &mut origin) } != 0).then_some((rect, origin))
    }

    fn screen_rect(surface: BackdropSurface, client: RECT, origin: Point) -> Option<RECT> {
        if surface.width <= 0 || surface.height <= 0 {
            return None;
        }
        let left = surface.x.max(0);
        let top = surface.y.max(0);
        let right = surface.x.saturating_add(surface.width).min(client.right);
        let bottom = surface.y.saturating_add(surface.height).min(client.bottom);
        (left < right && top < bottom).then(|| RECT {
            left: left.saturating_add(origin.x),
            top: top.saturating_add(origin.y),
            right: right.saturating_add(origin.x),
            bottom: bottom.saturating_add(origin.y),
        })
    }

    pub fn sync(overlay: isize, surfaces: Vec<BackdropSurface>, dark: bool) -> Vec<u32> {
        SURFACES.with_borrow_mut(|windows| {
            let mut order = Vec::new();
            let mut applied = Vec::new();
            let mut active = HashSet::new();
            let mut warming = Vec::new();
            if !surfaces.is_empty() && allow_materials() {
                if let Some((client, origin)) = client_bounds(overlay) {
                    let mut above = overlay;
                    for request in surfaces.into_iter().take(MAX_SURFACES) {
                        if active.contains(&request.id) {
                            continue;
                        }
                        let Some(rect) = screen_rect(request, client, origin) else {
                            continue;
                        };
                        if windows
                            .get(&request.id)
                            .is_some_and(|window| window.material != request.material)
                        {
                            windows.remove(&request.id);
                        }
                        let window = match windows.entry(request.id) {
                            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                            std::collections::hash_map::Entry::Vacant(entry) => {
                                let Ok(window) = NativeSurface::create(request.material, dark)
                                else {
                                    continue;
                                };
                                entry.insert(window)
                            }
                        };
                        let first_frame = window.bounds.is_none()
                            || unsafe { IsWindowVisible(window.hwnd.0 as isize) } == 0;
                        if window.place(rect, above, dark) {
                            above = window.hwnd.0 as isize;
                            if first_frame {
                                let _ = unsafe { UpdateWindow(window.hwnd) };
                                warming.push((request.id, above));
                            }
                            order.push(above);
                            applied.push(request.id);
                            active.insert(request.id);
                        }
                    }
                }
            }
            let had_removed_surfaces = windows.len() > active.len();
            windows.retain(|id, _| active.contains(id));
            *ORDER.lock().unwrap_or_else(|error| error.into_inner()) = order.clone();
            // Wait for both new backing frames and removals before the WebView
            // exposes Acrylic or moves a surface whose backing was suspended.
            if (!warming.is_empty() || had_removed_surfaces) && unsafe { DwmFlush() }.is_err() {
                for (id, hwnd) in warming {
                    windows.remove(&id);
                    applied.retain(|value| *value != id);
                    order.retain(|value| *value != hwnd);
                }
                *ORDER.lock().unwrap_or_else(|error| error.into_inner()) = order;
            }
            applied
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn clips_physical_backdrop_rectangles_to_the_overlay() {
            let source = BackdropSurface {
                id: 1,
                material: BackdropMaterial::Acrylic,
                x: -15,
                y: 90,
                width: 80,
                height: 30,
            };
            let client = RECT {
                left: 0,
                top: 0,
                right: 250,
                bottom: 100,
            };
            let result = screen_rect(source, client, Point { x: -1280, y: 40 }).unwrap();
            assert_eq!(
                (result.left, result.top, result.right, result.bottom),
                (-1280, 130, -1215, 140)
            );
            assert!(screen_rect(
                BackdropSurface { x: 300, ..source },
                client,
                Point::default()
            )
            .is_none());
        }
    }
}
