//! DeskChan Tauri application entry point.

use std::sync::Arc;
use tauri::Manager;

mod bindings;
mod config;
mod desktop;
mod shell_menu;
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

            // Create default config — all desktop files as free-floating icons
            // (positions use the -1 sentinel; the frontend assigns grid slots)
            let config_path = data_dir.join("deskchan.toml");
            if !config_path.exists() {
                let free_icons = desktop::list_entries()
                    .into_iter()
                    .map(|(path, is_dir)| desktop::make_icon(&path, is_dir))
                    .collect();
                let cfg = config::DeskConfig {
                    free_icons,
                    ..config::DeskConfig::default()
                };
                config::save_config(&config_path, &cfg)
                    .expect("failed to write default config");
            } else {
                // Migrate old configs (v2 → v3): move cell icons to free_icons
                let mut cfg = config::load_config(&config_path)
                    .expect("failed to load config");
                if cfg.version < 3 {
                    for cell in &mut cfg.cells {
                        cfg.free_icons.append(&mut cell.icons);
                    }
                    cfg.cells.clear();
                    cfg.version = 3;
                    config::save_config(&config_path, &cfg)
                        .expect("failed to save migrated config");
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
            window_manager::start_background_threads(app.handle().clone(), state);

            // Watch the desktop folders → emit `desktop-changed` for JS reconcile
            desktop::start_watcher(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bindings::get_config,
            bindings::save_config,
            bindings::open_file,
            bindings::set_dragging,
            bindings::get_file_icon,
            bindings::quit_app,
            bindings::reset_config,
            bindings::scan_desktop,
            bindings::copy_to_desktop,
            bindings::show_icon_menu,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Tauri application");
}
