use crate::config::{self, DeskConfig};
use crate::window_manager::DeskState;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::Manager;

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app data dir").join("deskchan.toml")
}

#[tauri::command] pub fn get_config(app: tauri::AppHandle) -> Result<DeskConfig, String> { config::load_config(&config_path(&app)).map_err(|e| e.to_string()) }
#[tauri::command] pub fn save_config(app: tauri::AppHandle, cfg: DeskConfig) -> Result<(), String> { config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string()) }
#[tauri::command] pub fn open_file(path: String) -> Result<(), String> { tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string()) }
#[tauri::command] pub fn set_dragging(state: tauri::State<'_, Arc<DeskState>>, dragging: bool) { state.dragging.store(dragging, Ordering::Relaxed); }
#[tauri::command] pub fn get_file_icon(path: String) -> Result<String, String> { crate::window_manager::get_file_icon_base64(&path) }

/// Show desktop icons and quit cleanly via Tauri's exit.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    crate::window_manager::show_desktop_icons();
    app.exit(0);
    Ok(())
}

/// Delete the config file so next launch re-scans the desktop.
#[tauri::command]
pub fn reset_config(app: tauri::AppHandle) -> Result<(), String> {
    let path = config_path(&app);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    crate::window_manager::show_desktop_icons();
    app.exit(0);
    Ok(())
}

/// Organize all free-floating icons into categorized cells (Folders / Apps / Files).
#[tauri::command]
pub fn organize_icons(app: tauri::AppHandle) -> Result<DeskConfig, String> {
    let cfg_path = config_path(&app);
    let mut cfg: DeskConfig = config::load_config(&cfg_path).map_err(|e| e.to_string())?;

    let (folders, apps, files) = partition_icons(&cfg.free_icons);
    cfg.free_icons.clear();

    let mut cells = Vec::new();
    if !folders.is_empty() {
        cells.push(make_cell("Folders", 50.0, 50.0, folders));
    }
    if !apps.is_empty() {
        let x = if cells.is_empty() { 50.0 } else { 420.0 };
        cells.push(make_cell("Applications", x, 50.0, apps));
    }
    if !files.is_empty() {
        let x = 50.0 + (cells.len() as f64) * 370.0;
        cells.push(make_cell("Files", x, 50.0, files));
    }
    cfg.cells = cells;
    cfg.version = 3;

    config::save_config(&cfg_path, &cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

fn partition_icons(icons: &[config::DesktopIcon]) -> (Vec<config::DesktopIcon>, Vec<config::DesktopIcon>, Vec<config::DesktopIcon>) {
    let mut folders = Vec::new();
    let mut apps = Vec::new();
    let mut files = Vec::new();
    for icon in icons {
        let path = std::path::Path::new(&icon.path);
        if path.is_dir() {
            folders.push(icon.clone());
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if config::is_app_extension(ext) { apps.push(icon.clone()); } else { files.push(icon.clone()); }
        } else {
            files.push(icon.clone());
        }
    }
    (folders, apps, files)
}

fn make_cell(title: &str, x: f64, y: f64, icons: Vec<config::DesktopIcon>) -> config::Cell {
    config::Cell {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        rect: config::CellRect { x, y, width: 320.0, height: 280.0 },
        background_color: None,
        opacity: 0.85,
        layout: config::CellLayout::Grid,
        icons,
    }
}
