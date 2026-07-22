//! DeskChan Tauri application entry point.

use std::sync::Arc;
use tauri::Manager;

mod bindings;
mod config;
mod window_manager;

fn desktop_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return std::path::PathBuf::from(profile).join("Desktop");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return std::path::PathBuf::from(home).join("Desktop");
    }
    std::path::PathBuf::from(".")
}

/// Scan the desktop folder for files/folders to populate initial config.
fn scan_desktop() -> Vec<config::DesktopIcon> {
    let mut icons = Vec::new();
    let Ok(entries) = std::fs::read_dir(desktop_dir()) else { return icons };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") { continue }
        let display = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string();
        icons.push(config::DesktopIcon {
            id: uuid::Uuid::new_v4().to_string(),
            name: display,
            path: path.to_string_lossy().to_string(),
            icon_path: None,
        });
    }
    icons
}

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

            // Create default config if missing — populate from actual desktop files
            let config_path = data_dir.join("deskchan.toml");
            if !config_path.exists() {
                let mut cfg = config::DeskConfig::default();
                let icons = scan_desktop();
                if !icons.is_empty() {
                    cfg.cells[0].title = "Desktop".to_string();
                    cfg.cells[0].icons = icons;
                }
                config::save_config(&config_path, &cfg)
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
            bindings::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Tauri application");
}
