//! Desktop folder helpers: enumeration, filtering, and change watching.
//!
//! Single source of truth for "what appears as a desktop icon" - the JS side
//! must not re-filter. Like the native shell, the user desktop is merged with
//! the public desktop (C:\Users\Public\Desktop, where installers put
//! all-users shortcuts).

use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
const FOLDERID_DESKTOP: crate::win32::Guid = crate::win32::Guid {
    d1: 0xb4bfcc3a,
    d2: 0xdb2c,
    d3: 0x424c,
    d4: [0xb0, 0x29, 0x7f, 0xe9, 0x9a, 0x87, 0xc6, 0x41],
};

#[cfg(target_os = "windows")]
fn configured_desktop_dir() -> Option<PathBuf> {
    use std::ffi::c_void;

    extern "system" {
        fn SHGetKnownFolderPath(
            rfid: *const crate::win32::Guid,
            flags: u32,
            token: isize,
            path: *mut *mut u16,
        ) -> i32;
        fn CoTaskMemFree(ptr: *mut c_void);
    }

    let _com = crate::win32::ComGuard::init();
    let mut raw_path: *mut u16 = std::ptr::null_mut();
    let result = unsafe { SHGetKnownFolderPath(&FOLDERID_DESKTOP, 0, 0, &mut raw_path) };
    if result < 0 || raw_path.is_null() {
        return None;
    }

    let len = unsafe { (0..).take_while(|&i| *raw_path.add(i) != 0).count() };
    let path = PathBuf::from(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(raw_path, len)
    }));
    unsafe { CoTaskMemFree(raw_path.cast()) };
    Some(path)
}

/// The user's own desktop folder (write target for `copy_to_desktop`).
pub fn user_desktop_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = configured_desktop_dir() {
            return path;
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Desktop");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Desktop");
    }
    PathBuf::from(".")
}

/// All folders whose contents appear as desktop icons (user + public).
pub fn desktop_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![user_desktop_dir()];
    #[cfg(target_os = "windows")]
    {
        let public = std::env::var("PUBLIC")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"C:\Users\Public"))
            .join("Desktop");
        if public.is_dir() {
            dirs.push(public);
        }
    }
    dirs
}

/// Whether a directory entry should appear as a desktop icon.
fn is_visible(path: &Path, name: &str) -> bool {
    if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") {
        return false;
    }

    // read_dir returns filesystem entries that Explorer deliberately omits.
    // In particular, anti-ransomware products place hidden/system canary
    // junctions on the Public Desktop. Inspect the entry itself rather than
    // following a reparse point to its shared bait directory.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            let attributes = metadata.file_attributes();
            if attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0 {
                return false;
            }
        }
    }

    true
}

/// List all visible desktop entries as (path, is_dir). Folders first, then
/// apps, then other files, each group sorted by name - close to the native
/// default sort order.
pub fn list_entries() -> Vec<(PathBuf, bool)> {
    let mut folders = Vec::new();
    let mut apps = Vec::new();
    let mut files = Vec::new();
    for dir in desktop_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_visible(&path, name) {
                continue;
            }
            if path.is_dir() {
                folders.push(path);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(crate::config::is_app_extension)
            {
                apps.push(path);
            } else {
                files.push(path);
            }
        }
    }
    let by_name = |p: &PathBuf| p.file_name().map(|s| s.to_string_lossy().to_lowercase());
    folders.sort_by_key(by_name);
    apps.sort_by_key(by_name);
    files.sort_by_key(by_name);
    folders
        .into_iter()
        .map(|p| (p, true))
        .chain(apps.into_iter().chain(files).map(|p| (p, false)))
        .collect()
}

/// Build a DesktopIcon for a desktop entry. Position uses the -1 sentinel:
/// the frontend assigns the first free grid slot on reconcile.
pub fn make_icon(path: &Path, is_dir: bool) -> crate::config::DesktopIcon {
    let display = display_name(path, is_dir);
    crate::config::DesktopIcon {
        id: uuid::Uuid::new_v4().to_string(),
        name: display,
        path: path.to_string_lossy().to_string(),
        icon_path: None,
        pos_x: -1.0,
        pos_y: -1.0,
    }
}

pub fn display_name(path: &Path, is_dir: bool) -> String {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("?");
    // Folders keep their full name; files hide the extension (like Explorer)
    if is_dir {
        name.to_string()
    } else {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(name)
            .to_string()
    }
}

/// The config DeskChan creates on its very first run: default settings, no
/// cells, and every current desktop file at its Explorer position when known.
pub fn first_run_config(
    layout: &crate::explorer_layout::ExplorerLayout,
) -> crate::config::DeskConfig {
    crate::config::DeskConfig {
        free_icons: list_entries()
            .into_iter()
            .map(|(path, is_dir)| {
                let mut icon = make_icon(&path, is_dir);
                if let Some((x, y)) = layout.position(&path) {
                    (icon.pos_x, icon.pos_y) = (x, y);
                }
                icon
            })
            .collect(),
        ..crate::config::DeskConfig::default()
    }
}
