//! Desktop folder helpers: enumeration, filtering, and change watching.
//!
//! Single source of truth for "what appears as a desktop icon" — the JS side
//! must not re-filter. Like the native shell, the user desktop is merged with
//! the public desktop (C:\Users\Public\Desktop, where installers put
//! all-users shortcuts).

use std::path::{Path, PathBuf};

/// The user's own desktop folder (write target for `copy_to_desktop`).
pub fn user_desktop_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
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
fn is_visible(name: &str) -> bool {
    !name.starts_with('.') && !name.eq_ignore_ascii_case("desktop.ini")
}

/// List all visible desktop entries as (path, is_dir). Folders first, then
/// apps, then other files, each group sorted by name — close to the native
/// default sort order.
pub fn list_entries() -> Vec<(PathBuf, bool)> {
    let mut folders = Vec::new();
    let mut apps = Vec::new();
    let mut files = Vec::new();
    for dir in desktop_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
            if !is_visible(name) {
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
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("?");
    // Folders keep their full name; files hide the extension (like Explorer)
    let display = if is_dir {
        name.to_string()
    } else {
        path.file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string()
    };
    crate::config::DesktopIcon {
        id: uuid::Uuid::new_v4().to_string(),
        name: display,
        path: path.to_string_lossy().to_string(),
        icon_path: None,
        pos_x: -1.0,
        pos_y: -1.0,
    }
}

/// Watch the desktop folders and emit a debounced `desktop-changed` event so
/// the frontend can reconcile its icon list (add new files, drop deleted
/// ones). Fixes the "dropping a file on the desktop never refreshes" bug —
/// previously nothing observed the folder at all.
pub fn start_watcher(app: tauri::AppHandle) {
    use notify::{recommended_watcher, RecursiveMode, Watcher};
    use tauri::Emitter;

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = match recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    }) {
        Ok(w) => w,
        Err(_) => return, // no watcher → manual refresh still works
    };
    for dir in desktop_dirs() {
        let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
    }
    std::thread::spawn(move || {
        let _watcher = watcher; // keep the watcher alive for the app's lifetime
        while rx.recv().is_ok() {
            // Debounce: a file copy fires many events in a burst; wait until
            // the folder has been quiet for 300ms before notifying JS.
            while rx.recv_timeout(std::time::Duration::from_millis(300)).is_ok() {}
            let _ = app.emit("desktop-changed", ());
        }
    });
}
