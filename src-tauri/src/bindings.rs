use crate::config::{self, DeskConfig, DesktopEntry, DesktopScan};
use crate::desktop;
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

/// Scan the desktop folders (user + public). The frontend reconciles the
/// result with its config: adds entries not yet known, removes desktop-owned
/// icons whose file disappeared. No config file I/O here — avoids save races
/// with the frontend's debounced save.
#[tauri::command]
pub fn scan_desktop() -> DesktopScan {
    DesktopScan {
        dirs: desktop::desktop_dirs()
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect(),
        entries: desktop::list_entries()
            .into_iter()
            .map(|(path, is_dir)| DesktopEntry { path: path.to_string_lossy().to_string(), is_dir })
            .collect(),
    }
}

/// Re-scan the desktop, preserve cells, rebuild free_icons from current
/// desktop files (see desktop::reset_free_icons).
#[tauri::command]
pub fn reset_config(app: tauri::AppHandle) -> Result<DeskConfig, String> {
    let cfg_path = config_path(&app);
    // Load existing config to preserve cells; if missing, start fresh
    let mut cfg = config::load_config(&cfg_path).unwrap_or_default();
    desktop::reset_free_icons(&mut cfg);
    config::save_config(&cfg_path, &cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

/// Copy a file to the desktop folder and return its new path.
#[tauri::command]
pub fn copy_to_desktop(path: String) -> Result<String, String> {
    desktop::copy_file_to_desktop(&path)
}

/// Show the native Windows shell context menu for a file at the cursor.
/// `extra_items` are appended after a separator; returns the index of the
/// picked extra item, or None when a native verb ran / menu was dismissed.
/// Async so the blocking menu loop never runs on a Tauri core thread.
#[tauri::command]
pub async fn show_icon_menu(
    window: tauri::WebviewWindow,
    path: String,
    extra_items: Vec<String>,
) -> Result<Option<u32>, String> {
    crate::shell_menu::show(window, path, extra_items)
}

// Note: one-click organize lives in TS (src/lib/organize.ts) — it needs
// i18n cell titles and viewport-aware layout, which only the frontend has.
