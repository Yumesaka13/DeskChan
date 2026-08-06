//! DeskChan Tauri application entry point.

use serde::Deserialize;
use std::sync::Arc;
use tauri::{Listener, Manager};

#[derive(Deserialize)]
struct NativeDropPayload {
    paths: Vec<std::path::PathBuf>,
}

mod bindings;
mod config;
mod desktop;
mod native_drag;
mod path_security;
mod shell_menu;
#[cfg(target_os = "windows")]
mod win32;
mod window_manager;

/// Move an unreadable/unrepairable config aside (without clobbering an
/// existing backup) and start fresh. The backup file is the ONLY trace the
/// user has of their old layout, so it must not be overwritten by a second
/// incident.
fn set_aside_corrupt_config(config_path: &std::path::Path, data_dir: &std::path::Path) {
    let corrupt = data_dir.join("deskchan.toml.corrupt");
    let corrupt = if corrupt.exists() {
        data_dir.join(format!(
            "deskchan.toml.corrupt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0)
        ))
    } else {
        corrupt
    };
    let _ = std::fs::rename(config_path, corrupt);
    let _ = config::save_config(config_path, &desktop::first_run_config());
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Ensure config directory exists
            let data_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data_dir).ok();

            // Undo backups only matter within a session (the undo history is
            // frontend state); anything left by a previous run is garbage
            // that would otherwise accumulate on disk forever.
            let _ = std::fs::remove_dir_all(data_dir.join("undo"));

            // Create default config - all desktop files as free-floating icons
            // (positions use the -1 sentinel; the frontend assigns grid slots)
            let config_path = data_dir.join("deskchan.toml");
            if !config_path.exists() {
                if let Err(error) = config::save_config(&config_path, &desktop::first_run_config())
                {
                    // A write failure (disk full, folder lockdown) must not
                    // crash startup - retry next launch.
                    eprintln!("DeskChan: failed to write default config: {error}");
                }
            } else {
                match config::parse_config(&config_path) {
                    // Migrate old configs (v2 -> v3): move cell icons to free_icons
                    Ok(mut cfg) => {
                        let mut needs_save = false;
                        if cfg.version < 3 {
                            for cell in &mut cfg.cells {
                                cfg.free_icons.append(&mut cell.icons);
                            }
                            cfg.cells.clear();
                            cfg.version = 3;
                            needs_save = true;
                        }
                        // A file that parses but fails validation is mostly
                        // intact - repair the offending fields instead of
                        // resetting every cell arrangement. Only genuinely
                        // unparseable content (or an unrepairable future
                        // version) takes the corrupt path below.
                        if let Err(error) = config::validate_config(&cfg) {
                            let fixed = config::repair_config(&mut cfg);
                            if let Err(still) = config::validate_config(&cfg) {
                                eprintln!(
                                    "DeskChan: config is not repairable ({fixed} fixes tried): \
                                     {error}; {still}"
                                );
                                set_aside_corrupt_config(&config_path, &data_dir);
                            } else {
                                eprintln!("DeskChan: repaired {fixed} config issue(s): {error}");
                                needs_save = true;
                            }
                        }
                        if needs_save {
                            if let Err(error) = config::save_config(&config_path, &cfg) {
                                // Failed to persist the repaired/migrated
                                // config; keep running with the in-memory copy.
                                eprintln!("DeskChan: failed to save config: {error}");
                            }
                        }
                    }
                    // An unparseable config must never brick startup (the old
                    // .expect here did): set it aside for inspection and
                    // start fresh.
                    Err(error) => {
                        eprintln!("DeskChan: config is unparseable: {error}");
                        set_aside_corrupt_config(&config_path, &data_dir);
                    }
                }
            }

            // Desktop window initialization (Windows-only: AppBar + WndProc + styles)
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                window_manager::init(&window);
            }

            // Size window to work area
            window_manager::fit_to_work_area(app.handle());

            // Background threads: cursor polling + Z-order defense
            let state = Arc::new(window_manager::DeskState::new());
            app.manage(state.clone());
            let authorizations = path_security::PathAuthorizations::default();
            authorizations.authorize(desktop::list_entries().into_iter().map(|(path, _)| path));
            // Config icons may point outside the desktop folders (imported
            // layouts) - re-authorize them at startup so open / icon
            // extraction / rename work before the first desktop scan (which
            // only covers the desktop folders).
            if let Ok(cfg) = config::load_config(&config_path) {
                authorizations.authorize(config::config_icon_paths(&cfg));
            }
            app.manage(authorizations);
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.listen("tauri://drag-drop", move |event| {
                    if let Ok(payload) = serde_json::from_str::<NativeDropPayload>(event.payload())
                    {
                        handle
                            .state::<path_security::PathAuthorizations>()
                            .authorize(payload.paths);
                    }
                });
            }
            window_manager::start_background_threads(app.handle().clone(), state);

            // Watch the desktop folders -> emit `desktop-changed` for JS reconcile
            desktop::start_watcher(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bindings::get_config,
            bindings::save_config,
            bindings::open_file,
            bindings::start_native_file_drag,
            bindings::file_action,
            bindings::rename_desktop_icon_with_undo,
            bindings::set_dragging,
            bindings::get_file_icon,
            bindings::quit_app,
            bindings::reset_config,
            bindings::scan_desktop,
            bindings::move_to_desktop,
            bindings::move_to_desktop_with_undo,
            bindings::paste_from_clipboard,
            bindings::paste_from_clipboard_with_undo,
            bindings::delete_with_undo,
            bindings::undo_file_operation,
            bindings::redo_file_operation,
            bindings::discard_undo_backups,
            bindings::export_config,
            bindings::import_config,
            bindings::show_icon_menu,
            bindings::show_desktop_menu,
            bindings::toggle_show_desktop,
            bindings::open_settings,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(|app, event| {
            // Restore the native desktop icons no matter how the process
            // ends. quit_app does this itself on a clean exit, so this only
            // matters for crashes, kills, and logoff - which otherwise leave
            // the real desktop icon list hidden forever. The polling thread
            // must see `running == false` first or it would re-hide them.
            if let tauri::RunEvent::Exit = event {
                #[cfg(target_os = "windows")]
                {
                    if let Some(state) = app.try_state::<Arc<window_manager::DeskState>>() {
                        state
                            .running
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                    // One 33ms tick covers the loop's post-sleep flag check.
                    std::thread::sleep(std::time::Duration::from_millis(60));
                    window_manager::show_desktop_icons();
                }
            }
        });
}
