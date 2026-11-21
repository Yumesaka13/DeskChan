//! Windows desktop session lifecycle and native event routing.

use crate::{
    desktop,
    layout_store::LayoutStore,
    path_security::PathAuthorizations,
    window_manager::{self, DeskState},
};
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
use tauri::{App, AppHandle, Listener, Manager, RunEvent};

#[derive(Deserialize)]
struct NativeDropPayload {
    paths: Vec<PathBuf>,
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    // Match the coordinate space before Explorer's view is hidden.
    window_manager::fit_to_work_area(handle);
    let data = app.path().app_data_dir()?;
    if let Err(error) = std::fs::create_dir_all(&data) {
        eprintln!("DeskChan: could not create the application data directory: {error}");
    }
    #[cfg(target_os = "windows")]
    let _ = crate::update::clean_cache(handle);
    // Undo entries do not outlive a desktop session.
    let _ = std::fs::remove_dir_all(data.join("undo"));

    let (store, icons) = LayoutStore::open(handle, &data);
    let authorizations = PathAuthorizations::default();
    authorizations.authorize(desktop::list_entries().into_iter().map(|(path, _)| path));
    authorizations.authorize(icons);
    app.manage(store);
    app.manage(authorizations);

    let state = Arc::new(DeskState::new());
    app.manage(state.clone());
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        window_manager::init(&window);
        let handle = handle.clone();
        window.listen("tauri://drag-drop", move |event| {
            if let Ok(drop) = serde_json::from_str::<NativeDropPayload>(event.payload()) {
                handle.state::<PathAuthorizations>().authorize(drop.paths);
            }
        });
    }
    window_manager::fit_to_work_area(handle);
    window_manager::start_background_threads(handle.clone(), state);
    desktop::start_watcher(handle.clone());
    Ok(())
}

pub fn on_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::Exit = event {
        // Stop the polling thread before bringing back Explorer's icons.
        // A second call from RunEvent::Exit after a clean quit is harmless.
        if let Some(state) = app.try_state::<Arc<DeskState>>() {
            restore_explorer(&state);
        }
    }
}

pub fn restore_explorer(state: &DeskState) {
    if state.running.swap(false, Ordering::AcqRel) {
        #[cfg(target_os = "windows")]
        {
            std::thread::sleep(std::time::Duration::from_millis(50));
            window_manager::show_desktop_icons();
        }
    }
}
