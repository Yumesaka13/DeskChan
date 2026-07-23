use crate::config::{self, CellRect, DeskConfig};
use crate::window_manager::DeskState;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app data dir").join("deskchan.toml")
}

#[tauri::command] pub fn get_config(app: tauri::AppHandle) -> Result<DeskConfig, String> { config::load_config(&config_path(&app)).map_err(|e| e.to_string()) }
#[tauri::command] pub fn save_config(app: tauri::AppHandle, cfg: DeskConfig) -> Result<(), String> { config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string()) }
#[tauri::command] pub fn open_file(path: String) -> Result<(), String> { tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string()) }
#[tauri::command] pub fn update_cell_regions(state: tauri::State<'_, Arc<DeskState>>, regions: Vec<CellRect>) { *state.regions.lock().unwrap() = regions; }
#[tauri::command] pub fn get_file_icon(path: String) -> Result<String, String> { crate::window_manager::get_file_icon_base64(&path) }

/// Show desktop icons and quit. All files stay in place — we just unhide SysListView32.
#[tauri::command]
pub fn quit_app() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    crate::window_manager::show_desktop_icons();
    std::process::exit(0);
}

/// Delete the config file so next launch re-scans the desktop.
#[tauri::command]
pub fn reset_config(app: tauri::AppHandle) -> Result<(), String> {
    let path = config_path(&app);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    // Exit so user can restart cleanly
    #[cfg(target_os = "windows")]
    crate::window_manager::show_desktop_icons();
    std::process::exit(0);
}
