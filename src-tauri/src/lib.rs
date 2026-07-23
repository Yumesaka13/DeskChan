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
            icon_path: None,
        };
        if path.is_dir() {
            folders.push(icon);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            match ext.to_lowercase().as_str() {
                "exe" | "lnk" | "bat" | "cmd" | "msc" => apps.push(icon),
                _ => files.push(icon),
            }
        } else {
            files.push(icon); // no extension → general file
        }
    }
    (folders, apps, files)
}

fn make_default_cell(title: &str, x: f64, y: f64, w: f64, h: f64, icons: Vec<config::DesktopIcon>) -> config::Cell {
    config::Cell {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        rect: config::CellRect { x, y, width: w, height: h },
        background_color: None,
        opacity: 0.85,
        layout: config::CellLayout::Grid,
        icons,
    }
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

            // Create default config — categorize desktop files into cells
            let config_path = data_dir.join("deskchan.toml");
            if !config_path.exists() {
                let (folders, apps, files) = scan_desktop_categorized();
                let mut cells = Vec::new();
                if !folders.is_empty() {
                    cells.push(make_default_cell("Folders", 50.0, 50.0, 320.0, 280.0, folders));
                }
                if !apps.is_empty() {
                    let x = if cells.is_empty() { 50.0 } else { 420.0 };
                    cells.push(make_default_cell("Applications", x, 50.0, 320.0, 280.0, apps));
                }
                if !files.is_empty() {
                    let x = if cells.len() < 2 { 50.0 + (cells.len() as f64) * 370.0 } else { 790.0 };
                    cells.push(make_default_cell("Files", x, 50.0, 320.0, 280.0, files));
                }
                let cfg = config::DeskConfig {
                    cells,
                    ..config::DeskConfig::default()
                };
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
            bindings::reset_config,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Tauri application");
}
