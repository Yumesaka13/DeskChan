use crate::config::{self, DeskConfig};
use crate::window_manager::DeskState;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::Manager;

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app data dir").join("deskchan.toml")
}

fn desktop_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Desktop");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Desktop");
    }
    PathBuf::from(".")
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

/// Re-scan desktop, preserve cells, reset free_icons to current desktop files.
#[tauri::command]
pub fn reset_config(app: tauri::AppHandle) -> Result<DeskConfig, String> {
    let cfg_path = config_path(&app);
    // Load existing config to preserve cells; if missing, start fresh
    let mut cfg = config::load_config(&cfg_path).unwrap_or_default();
    cfg.free_icons.clear();
    let desktop = desktop_dir();
    if let Ok(entries) = std::fs::read_dir(&desktop) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
            if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") { continue; }
            let display = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string();
            cfg.free_icons.push(config::DesktopIcon {
                id: uuid::Uuid::new_v4().to_string(), name: display,
                path: path.to_string_lossy().to_string(),
                icon_path: None, pos_x: 0.0, pos_y: 0.0,
            });
        }
    }
    config::save_config(&cfg_path, &cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
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

/// Scan desktop for new files not yet in free_icons. Returns only the new icons.
/// The caller (JS) merges them into the live config signal — no disk save or full-config return.
#[tauri::command]
pub fn refresh_desktop(app: tauri::AppHandle) -> Result<Vec<config::DesktopIcon>, String> {
    let cfg_path = config_path(&app);
    let cfg: DeskConfig = config::load_config(&cfg_path).map_err(|e| e.to_string())?;

    // Build a set of existing filenames (case-insensitive)
    let existing_names: std::collections::HashSet<String> =
        cfg.free_icons.iter().filter_map(|i| {
            std::path::Path::new(&i.path).file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase())
        }).collect();

    let mut new_icons = Vec::new();

    if let Ok(entries) = std::fs::read_dir(desktop_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
            if existing_names.contains(&name.to_lowercase()) { continue; }
            if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") { continue; }
            let display = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string();
            new_icons.push(config::DesktopIcon {
                id: uuid::Uuid::new_v4().to_string(),
                name: display,
                path: path.to_string_lossy().to_string(),
                icon_path: None,
                pos_x: 0.0, pos_y: 0.0,
            });
        }
    }

    Ok(new_icons)
}

/// Copy a file to the desktop folder and return its new path.
#[tauri::command]
pub fn copy_to_desktop(path: String) -> Result<String, String> {
    let desktop = desktop_dir();
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

/// Toggle arrangement flags for free icons.
#[tauri::command]
pub fn set_arrangement(app: tauri::AppHandle, auto_arrange: bool, snap_to_grid: bool) -> Result<DeskConfig, String> {
    let cfg_path = config_path(&app);
    let mut cfg: DeskConfig = config::load_config(&cfg_path).map_err(|e| e.to_string())?;
    cfg.auto_arrange = auto_arrange;
    cfg.snap_to_grid = snap_to_grid;
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
