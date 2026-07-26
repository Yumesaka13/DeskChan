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

/// Serializes every access to the config FILE. Async commands run
/// concurrently on the tokio pool — without this, a debounced save racing
/// reset/import's load-modify-write could interleave writes or read a
/// partial file (sync commands used to be serialized by the main thread).
static CONFIG_LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

// I/O-bound commands are async ON PURPOSE: sync Tauri commands run on the
// MAIN thread, so a burst of icon extractions (COM + GDI + PNG encode per
// file) froze the whole UI for seconds at startup. Async commands run on
// the async runtime's thread pool instead.
#[tauri::command] pub async fn get_config(app: tauri::AppHandle) -> Result<DeskConfig, String> { let _g = CONFIG_LOCK.lock().await; config::load_config(&config_path(&app)).map_err(|e| e.to_string()) }
#[tauri::command] pub async fn save_config(app: tauri::AppHandle, cfg: DeskConfig) -> Result<(), String> { let _g = CONFIG_LOCK.lock().await; config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string()) }
#[tauri::command] pub async fn open_file(path: String) -> Result<(), String> { tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string()) }
#[tauri::command] pub fn set_dragging(state: tauri::State<'_, Arc<DeskState>>, dragging: bool) { state.dragging.store(dragging, Ordering::Relaxed); }
#[tauri::command] pub async fn get_file_icon(path: String) -> Result<String, String> { crate::window_manager::get_file_icon_base64(&path) }

/// Show desktop icons and quit cleanly via Tauri's exit.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle, state: tauri::State<'_, Arc<DeskState>>) -> Result<(), String> {
    // Stop the polling thread FIRST and outwait one full tick — its re-hide
    // guard would otherwise race the restore below during teardown and leave
    // the user's real desktop iconless after we're gone.
    state.running.store(false, Ordering::Relaxed);
    std::thread::sleep(std::time::Duration::from_millis(50));
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
pub async fn scan_desktop() -> DesktopScan {
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

/// Restore the FIRST-RUN state: default settings, no cells, every desktop
/// file as a free icon. (The old version preserved cells, which made the
/// button look like it did nothing.)
#[tauri::command]
pub async fn reset_config(app: tauri::AppHandle) -> Result<DeskConfig, String> {
    let _g = CONFIG_LOCK.lock().await;
    let cfg = desktop::first_run_config();
    config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

/// Serialize the given (current UI) config to an arbitrary TOML file.
#[tauri::command]
pub async fn export_config(cfg: DeskConfig, path: String) -> Result<(), String> {
    config::save_config(std::path::Path::new(&path), &cfg).map_err(|e| e.to_string())
}

/// Parse a TOML config file and adopt it as the live config. Parsing
/// happens before anything is overwritten, so an invalid file is a no-op.
#[tauri::command]
pub async fn import_config(app: tauri::AppHandle, path: String) -> Result<DeskConfig, String> {
    let cfg = config::load_config(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    let _g = CONFIG_LOCK.lock().await;
    config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

/// Copy a file to the desktop folder and return its new path.
#[tauri::command]
pub async fn copy_to_desktop(path: String) -> Result<String, String> {
    desktop::copy_file_to_desktop(&path)
}

/// Show the native Windows shell context menu for one or more same-folder
/// files at the cursor (multi-selection works like Explorer's).
/// `extra_items` are appended after a separator; returns the index of the
/// picked extra item, or None when a native verb ran / menu was dismissed.
/// Async so the blocking menu loop never runs on a Tauri core thread.
#[tauri::command]
pub async fn show_icon_menu(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    extra_items: Vec<String>,
) -> Result<Option<u32>, String> {
    crate::shell_menu::show(window, paths, extra_items)
}

// Note: one-click organize lives in TS (src/lib/organize.ts) — it needs
// i18n cell titles and viewport-aware layout, which only the frontend has.
