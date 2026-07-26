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
/// desktop files. Files already living in a cell are skipped (the old
/// version duplicated them as free icons). Positions use the -1 sentinel:
/// the frontend assigns free grid slots on the next reconcile.
#[tauri::command]
pub fn reset_config(app: tauri::AppHandle) -> Result<DeskConfig, String> {
    let cfg_path = config_path(&app);
    // Load existing config to preserve cells; if missing, start fresh
    let mut cfg = config::load_config(&cfg_path).unwrap_or_default();
    let in_cells: std::collections::HashSet<String> = cfg
        .cells
        .iter()
        .flat_map(|c| c.icons.iter().map(|i| i.path.to_lowercase()))
        .collect();
    cfg.free_icons = desktop::list_entries()
        .into_iter()
        .filter(|(path, _)| !in_cells.contains(&path.to_string_lossy().to_lowercase()))
        .map(|(path, is_dir)| desktop::make_icon(&path, is_dir))
        .collect();
    config::save_config(&cfg_path, &cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

/// Copy a file to the desktop folder and return its new path.
#[tauri::command]
pub fn copy_to_desktop(path: String) -> Result<String, String> {
    let desktop = desktop::user_desktop_dir();
    let source = std::path::Path::new(&path);
    let filename = source.file_name().ok_or("invalid source")?;
    let dest = desktop.join(filename);
    let dest = if dest.exists() {
        // Avoid overwrite: append (n)
        let stem = dest.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = dest.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
        let mut n = 1;
        loop {
            let candidate = desktop.join(format!("{stem} ({n}){ext}"));
            if !candidate.exists() { break candidate; }
            n += 1;
        }
    } else { dest };
    std::fs::copy(source, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

// Note: one-click organize lives in TS (src/lib/organize.ts) — it needs
// i18n cell titles and viewport-aware layout, which only the frontend has.
