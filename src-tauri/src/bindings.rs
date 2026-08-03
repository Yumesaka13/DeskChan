use crate::config::{self, DeskConfig, DesktopEntry, DesktopScan};
use crate::desktop;
use crate::path_security::{self, PathAuthorizations};
use crate::window_manager::DeskState;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir")
        .join("deskchan.toml")
}

static CONFIG_LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

#[tauri::command]
pub async fn get_config(app: tauri::AppHandle) -> Result<DeskConfig, String> {
    let _guard = CONFIG_LOCK.lock().await;
    config::load_config(&config_path(&app)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, cfg: DeskConfig) -> Result<(), String> {
    config::validate_config(&cfg)?;
    path_security::validate_config_paths(&cfg)?;
    let _guard = CONFIG_LOCK.lock().await;
    config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_file(
    authorizations: tauri::State<'_, PathAuthorizations>,
    path: String,
) -> Result<(), String> {
    let path = authorizations.resolve(&path)?;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Explorer-like operations used by the styled file menu. Paths are resolved
/// through the same authorization registry as open/drop operations.
#[tauri::command]
pub async fn file_action(
    window: tauri::WebviewWindow,
    authorizations: tauri::State<'_, PathAuthorizations>,
    paths: Vec<String>,
    action: String,
) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 64 {
        return Err("invalid file selection".into());
    }
    let paths = paths
        .iter()
        .map(|path| authorizations.resolve(path))
        .collect::<Result<Vec<_>, _>>()?;

    #[cfg(target_os = "windows")]
    match action.as_str() {
        "copy" => crate::desktop::copy_paths_to_clipboard(&paths, false),
        "cut" => crate::desktop::copy_paths_to_clipboard(&paths, true),
        "delete" => crate::desktop::recycle_paths(&paths),
        "open_with" => {
            // The `openas` / `properties` ShellExecute verbs are ignored by
            // some registered default handlers. Shell32's explicit rundll32
            // entry points always show the Windows picker/property sheet.
            for path in paths {
                let path = path.to_string_lossy().to_string();
                std::process::Command::new("rundll32.exe")
                    .args(["shell32.dll,OpenAs_RunDLL", &path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        "properties" => crate::shell_menu::show_properties(
            window,
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect(),
        ),
        _ => Err("unsupported file action".into()),
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (paths, action);
        Err("file actions are only supported on Windows".into())
    }
}

#[tauri::command]
pub async fn open_settings(section: String) -> Result<(), String> {
    let uri = match section.as_str() {
        "personalization" => "ms-settings:personalization",
        "display" => "ms-settings:display",
        _ => return Err("unsupported settings section".into()),
    };
    tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_dragging(state: tauri::State<'_, Arc<DeskState>>, dragging: bool) {
    state.dragging.store(dragging, Ordering::Relaxed);
}

#[tauri::command]
pub async fn get_file_icon(
    authorizations: tauri::State<'_, PathAuthorizations>,
    path: String,
) -> Result<String, String> {
    let path = authorizations.resolve(&path)?;
    crate::window_manager::get_file_icon_base64(&path.to_string_lossy())
}

#[tauri::command]
pub fn quit_app(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<DeskState>>,
) -> Result<(), String> {
    state.running.store(false, Ordering::Relaxed);
    std::thread::sleep(std::time::Duration::from_millis(50));
    #[cfg(target_os = "windows")]
    crate::window_manager::show_desktop_icons();
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn scan_desktop(authorizations: tauri::State<'_, PathAuthorizations>) -> DesktopScan {
    let entries = desktop::list_entries();
    authorizations.authorize(entries.iter().map(|(path, _)| path.clone()));
    DesktopScan {
        dirs: desktop::desktop_dirs()
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        entries: entries
            .into_iter()
            .map(|(path, is_dir)| DesktopEntry {
                modified_at_millis: path
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as f64)
                    .unwrap_or(0.0),
                path: path.to_string_lossy().to_string(),
                is_dir,
            })
            .collect(),
    }
}

#[tauri::command]
pub async fn reset_config(app: tauri::AppHandle) -> Result<DeskConfig, String> {
    let _guard = CONFIG_LOCK.lock().await;
    let cfg = desktop::first_run_config();
    config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

#[tauri::command]
pub async fn export_config(app: tauri::AppHandle, cfg: DeskConfig) -> Result<bool, String> {
    config::validate_config(&cfg)?;
    path_security::validate_config_paths(&cfg)?;
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter("TOML", &["toml"])
        .set_file_name("deskchan.toml")
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let selected = selected.into_path().map_err(|e| e.to_string())?;
    let path = path_security::validate_toml_file(&selected.to_string_lossy(), false)?;
    config::save_config(&path, &cfg).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn import_config(app: tauri::AppHandle) -> Result<Option<DeskConfig>, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter("TOML", &["toml"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let selected = selected.into_path().map_err(|e| e.to_string())?;
    let path = path_security::validate_toml_file(&selected.to_string_lossy(), true)?;
    let cfg = config::load_config(&path).map_err(|e| e.to_string())?;
    config::validate_config(&cfg)?;
    path_security::validate_config_paths(&cfg)?;
    let _guard = CONFIG_LOCK.lock().await;
    config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string())?;
    Ok(Some(cfg))
}

#[tauri::command]
pub async fn move_to_desktop(
    authorizations: tauri::State<'_, PathAuthorizations>,
    path: String,
) -> Result<String, String> {
    let path = authorizations.resolve(&path)?;
    let moved = desktop::move_to_desktop(&path.to_string_lossy())?;
    authorizations.authorize([PathBuf::from(&moved)]);
    Ok(moved)
}

#[tauri::command]
pub async fn move_to_desktop_with_undo(
    authorizations: tauri::State<'_, PathAuthorizations>,
    path: String,
) -> Result<desktop::FileMutation, String> {
    let path = authorizations.resolve(&path)?;
    let mutation = desktop::move_to_desktop_with_undo(&path.to_string_lossy())?;
    authorizations.authorize(mutation.paths.iter().map(PathBuf::from));
    Ok(mutation)
}

#[tauri::command]
pub async fn paste_from_clipboard(
    authorizations: tauri::State<'_, PathAuthorizations>,
    mode: String,
) -> Result<Vec<String>, String> {
    let pasted = desktop::paste_from_clipboard(&mode)?;
    authorizations.authorize(pasted.iter().map(PathBuf::from));
    Ok(pasted)
}

#[tauri::command]
pub async fn paste_from_clipboard_with_undo(
    authorizations: tauri::State<'_, PathAuthorizations>,
    mode: String,
) -> Result<desktop::FileMutation, String> {
    let mutation = desktop::paste_from_clipboard_with_undo(&mode)?;
    authorizations.authorize(mutation.paths.iter().map(PathBuf::from));
    // Copy sources remain present and are required for a later redo.
    authorizations.authorize(mutation.record.sources.iter().map(PathBuf::from));
    Ok(mutation)
}

#[tauri::command]
pub async fn delete_with_undo(
    app: tauri::AppHandle,
    authorizations: tauri::State<'_, PathAuthorizations>,
    paths: Vec<String>,
) -> Result<desktop::FileMutation, String> {
    if paths.is_empty() || paths.len() > 64 {
        return Err("invalid file selection".into());
    }
    let paths = paths
        .iter()
        .map(|path| authorizations.resolve(path))
        .collect::<Result<Vec<_>, _>>()?;
    let backup = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("undo")
        .join(uuid::Uuid::new_v4().to_string());
    desktop::delete_with_undo(&paths, &backup)
}

#[tauri::command]
pub async fn rename_desktop_icon_with_undo(
    authorizations: tauri::State<'_, PathAuthorizations>,
    path: String,
    name: String,
    preserve_extension: bool,
) -> Result<desktop::RenamedIconMutation, String> {
    let path = authorizations.resolve(&path)?;
    let mutation = desktop::rename_with_undo(&path, &name, preserve_extension)?;
    authorizations.authorize([PathBuf::from(&mutation.path)]);
    Ok(mutation)
}

#[tauri::command]
pub async fn undo_file_operation(
    authorizations: tauri::State<'_, PathAuthorizations>,
    record: desktop::FileUndoRecord,
) -> Result<(), String> {
    // Current file locations must have originated from a desktop scan/drop.
    match record.kind.as_str() {
        "move" | "copy" | "rename" => {
            for destination in &record.destinations {
                authorizations.resolve(destination)?;
            }
        }
        "delete" => {
            for backup in &record.backups {
                crate::path_security::validate_existing_local_path(backup)?;
            }
        }
        _ => return Err("unsupported history operation".into()),
    }
    desktop::undo_file_operation(&record)?;
    authorizations.authorize(record.sources.iter().map(PathBuf::from));
    Ok(())
}

#[tauri::command]
pub async fn redo_file_operation(
    authorizations: tauri::State<'_, PathAuthorizations>,
    record: desktop::FileUndoRecord,
) -> Result<(), String> {
    match record.kind.as_str() {
        "move" | "copy" | "delete" | "rename" => {
            for source in &record.sources {
                authorizations.resolve(source)?;
            }
        }
        _ => return Err("unsupported history operation".into()),
    }
    desktop::redo_file_operation(&record)?;
    authorizations.authorize(record.destinations.iter().map(PathBuf::from));
    Ok(())
}

#[tauri::command]
pub async fn show_icon_menu(
    window: tauri::WebviewWindow,
    authorizations: tauri::State<'_, PathAuthorizations>,
    paths: Vec<String>,
    extra_items: Vec<String>,
) -> Result<Option<u32>, String> {
    if paths.is_empty() {
        return Err("no paths".into());
    }
    if paths.len() > 64
        || extra_items.len() > 1
        || extra_items
            .iter()
            .any(|item| item.is_empty() || item.len() > 128 || item.chars().any(char::is_control))
    {
        return Err("menu input exceeds limits".into());
    }
    let paths = paths
        .iter()
        .map(|path| authorizations.resolve(path))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    crate::shell_menu::show(window, paths, extra_items)
}

#[tauri::command]
pub async fn show_desktop_menu(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<DeskState>>,
) -> Result<(), String> {
    state
        .native_desktop_menu_open
        .store(true, Ordering::Relaxed);
    let result = crate::shell_menu::show_desktop(window);
    state
        .native_desktop_menu_open
        .store(false, Ordering::Relaxed);
    result
}
