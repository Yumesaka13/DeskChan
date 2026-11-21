//! Debounced file notification stream for the desktop session.

use super::catalog::desktop_dirs;

/// Watch the desktop folders and emit a debounced `desktop-changed` event so
/// the frontend can reconcile its icon list (add new files, drop deleted
/// ones). Fixes the "dropping a file on the desktop never refreshes" bug -
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
        Err(_) => return, // no watcher -> manual refresh still works
    };
    for dir in desktop_dirs() {
        let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
    }
    std::thread::spawn(move || {
        let _watcher = watcher; // keep the watcher alive for the app's lifetime
        while rx.recv().is_ok() {
            // Debounce: a file copy fires many events in a burst; wait until
            // the folder has been quiet for 300ms before notifying JS.
            while rx
                .recv_timeout(std::time::Duration::from_millis(300))
                .is_ok()
            {}
            let _ = app.emit("desktop-changed", ());
        }
    });
}
