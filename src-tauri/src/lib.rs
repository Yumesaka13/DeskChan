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

/// Scan the desktop folder for files/folders, categorized by type.
/// Returns (folders, apps, files) vectors.
fn scan_desktop_categorized() -> (Vec<config::DesktopIcon>, Vec<config::DesktopIcon>, Vec<config::DesktopIcon>) {
    let mut folders = Vec::new();
    let mut apps = Vec::new();
    let mut files = Vec::new();

    let Ok(entries) = std::fs::read_dir(desktop_dir()) else { return (folders, apps, files) };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") { continue }
        let display = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string();
        let icon = config::DesktopIcon {
            id: uuid::Uuid::new_v4().to_string(),
            name: display,
            path: path.to_string_lossy().to_string(),
            icon_path: None,            pos_x: 0.0, pos_y: 0.0,        };
        if path.is_dir() {
            folders.push(icon);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if config::is_app_extension(ext) { apps.push(icon); } else { files.push(icon); }
        } else {
            files.push(icon); // no extension → general file
        }
    }
    (folders, apps, files)
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

            // Create default config — all desktop files as free-floating icons
            let config_path = data_dir.join("deskchan.toml");
            if !config_path.exists() {
                let (folders, apps, files) = scan_desktop_categorized();
                let mut free_icons = Vec::new();
                free_icons.extend(folders);
                free_icons.extend(apps);
                free_icons.extend(files);
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
            bindings::organize_icons,
            bindings::scan_desktop_files,
            bindings::set_arrangement,
            bindings::copy_to_desktop,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Tauri application");
}
