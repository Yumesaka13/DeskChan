//! DeskChan Tauri application entry point.

use std::sync::Arc;
use tauri::Manager;

mod bindings;
mod config;
mod file_manager;
mod window_manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Ensure config directory exists
            let data_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data_dir).ok();

            // Create default config if missing
            let config_path = data_dir.join("deskchan.toml");
            if !config_path.exists() {
                config::save_config(&config_path, &config::DeskConfig::default())
                    .expect("failed to write default config");
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
            window_manager::start_background_threads(app.handle().clone(), state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bindings::get_config,
            bindings::save_config,
            bindings::open_file,
            bindings::update_cell_regions,
            bindings::get_file_icon,
            bindings::move_icon_to_cell,
            bindings::restore_icon,
            bindings::restore_and_quit,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Tauri application");
}
