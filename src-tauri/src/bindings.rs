use crate::config::{self, CellRect, DeskConfig};
use crate::window_manager::DeskState;
use serde::Serialize;
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

// ── File move / restore ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct MoveIconResult {
    pub id: String,
    pub name: String,
    pub path: String,
    pub original_path: String,
    pub icon_path: Option<String>,
}

/// Physically move a file into managed storage and return icon data.
#[tauri::command]
pub fn move_icon_to_cell(app: tauri::AppHandle, path: String, cell_id: String) -> Result<MoveIconResult, String> {
    let app_data = app.path().app_data_dir().expect("app data dir");
    let source = PathBuf::from(&path);
    let (new_path, original) = crate::file_manager::move_file(&source, &cell_id, &app_data)?;
    let name = source.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown").to_string();
    Ok(MoveIconResult { id: uuid::Uuid::new_v4().to_string(), name, path: new_path, original_path: original, icon_path: None })
}

/// Move a file back to its original location (when icon is removed from cell).
#[tauri::command]
pub fn restore_icon(path: String, original_path: String) -> Result<(), String> {
    crate::file_manager::restore_file(&PathBuf::from(&path), &PathBuf::from(&original_path))
}

/// Restore all managed files to original locations, save config, show icons, quit.
#[tauri::command]
pub fn restore_and_quit(app: tauri::AppHandle) -> Result<(), String> {
    let cfg_path = config_path(&app);
    let mut cfg: DeskConfig = config::load_config(&cfg_path).map_err(|e| e.to_string())?;
    for cell in &mut cfg.cells {
        for icon in &mut cell.icons {
            if !icon.original_path.is_empty() {
                let _ = crate::file_manager::restore_file(&PathBuf::from(&icon.path), &PathBuf::from(&icon.original_path));
                icon.path = icon.original_path.clone();
                icon.original_path.clear();
            }
        }
    }
    config::save_config(&cfg_path, &cfg).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    crate::window_manager::show_desktop_icons();
    std::process::exit(0);
}
