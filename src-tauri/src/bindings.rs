use crate::config::{self, DeskConfig, DesktopEntry, DesktopScan};
use crate::desktop;
use crate::path_security::{self, PathAuthorizations};
use crate::window_manager::DeskState;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Highest configuration write revision the backend has persisted. The
/// frontend stamps every save with a monotonically increasing revision so a
/// debounced save that was already in flight cannot clobber a newer
/// import/reset that landed afterwards.
static LAST_SAVE_REV: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn get_config(app: tauri::AppHandle) -> Result<DeskConfig, String> {
    let _guard = CONFIG_LOCK.lock().await;
    config::load_config(&config_path(&app)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, cfg: DeskConfig, rev: u64) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().await;
    // A stale write (older revision) must never overwrite a newer one -
    // otherwise a debounced save already in flight can clobber an
    // import/reset that landed afterwards.
    if rev <= LAST_SAVE_REV.load(Ordering::Relaxed) {
        return Ok(());
    }
    config::validate_config(&cfg)?;
    path_security::validate_config_paths(&cfg)?;
    config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string())?;
    LAST_SAVE_REV.store(rev, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn open_file(
    authorizations: tauri::State<'_, PathAuthorizations>,
    path: String,
) -> Result<(), String> {
    let path = authorizations.resolve(&path)?;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_native_file_drag(
    state: tauri::State<'_, Arc<DeskState>>,
    authorizations: tauri::State<'_, PathAuthorizations>,
    paths: Vec<String>,
) -> Result<u32, String> {
    if paths.is_empty() || paths.len() > 64 {
        return Err("invalid file selection".into());
    }
    let paths = paths
        .iter()
        .map(|path| authorizations.resolve(path))
        .collect::<Result<Vec<_>, _>>()?;
    state.dragging.store(true, Ordering::Relaxed);
    let result = crate::native_drag::drag_files(paths);
    state.dragging.store(false, Ordering::Relaxed);
    result
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
pub async fn rename_desktop_icon_with_undo(
    authorizations: tauri::State<'_, PathAuthorizations>,
    path: String,
    name: String,
    preserve_extension: bool,
) -> Result<desktop::RenamedIconMutation, String> {
    let source = authorizations.resolve(&path)?;
    let mutation = desktop::rename_with_undo(&source, &name, preserve_extension)?;
    authorizations.authorize([PathBuf::from(&mutation.path)]);
    Ok(mutation)
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
pub async fn scan_desktop(
    authorizations: tauri::State<'_, PathAuthorizations>,
) -> Result<DesktopScan, String> {
    // The watcher fires this on every desktop change; a synchronous command
    // would do the per-entry metadata()/stat calls on the UI thread and
    // stutter the overlay on mechanical drives or OneDrive-backed folders.
    let (entries, scan) = tauri::async_runtime::spawn_blocking(|| {
        let entries = desktop::list_entries();
        let scan = DesktopScan {
            dirs: desktop::desktop_dirs()
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect(),
            entries: entries
                .iter()
                .map(|(path, is_dir)| DesktopEntry {
                    modified_at_millis: path
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as f64)
                        .unwrap_or(0.0),
                    path: path.to_string_lossy().to_string(),
                    is_dir: *is_dir,
                })
                .collect(),
        };
        (entries, scan)
    })
    .await
    .map_err(|e| e.to_string())?;
    authorizations.authorize(entries.into_iter().map(|(path, _)| path));
    Ok(scan)
}

#[tauri::command]
pub async fn reset_config(app: tauri::AppHandle, rev: u64) -> Result<DeskConfig, String> {
    let _guard = CONFIG_LOCK.lock().await;
    let cfg = desktop::first_run_config();
    config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string())?;
    LAST_SAVE_REV.fetch_max(rev, Ordering::Relaxed);
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
pub async fn import_config(
    app: tauri::AppHandle,
    authorizations: tauri::State<'_, PathAuthorizations>,
    rev: u64,
) -> Result<Option<DeskConfig>, String> {
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
    // Imported icons may point anywhere local - re-authorize them so open /
    // icon extraction / rename still work after the desktop scan (which only
    // knows about the desktop folders).
    authorizations.authorize(config::config_icon_paths(&cfg));
    let _guard = CONFIG_LOCK.lock().await;
    config::save_config(&config_path(&app), &cfg).map_err(|e| e.to_string())?;
    LAST_SAVE_REV.fetch_max(rev, Ordering::Relaxed);
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
pub async fn delete_permanently_with_undo(
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
    desktop::delete_permanently_with_undo(&paths, &backup)
}

#[tauri::command]
pub async fn undo_file_operation(
    authorizations: tauri::State<'_, PathAuthorizations>,
    record: desktop::FileUndoRecord,
) -> Result<(), String> {
    // Every side of the operation is a renderer-supplied path. Read sides
    // must resolve against the authorization registry; WRITE sides must pass
    // the same gate (resolve_known: the file may not exist yet, e.g. a
    // deleted file being restored). Without this, a compromised renderer
    // could construct a record that moves a desktop file anywhere on disk.
    match record.kind.as_str() {
        "move" | "rename" => {
            for source in &record.sources {
                authorizations.resolve_known(source)?;
            }
            for destination in &record.destinations {
                authorizations.resolve(destination)?;
            }
        }
        "copy" => {
            for destination in &record.destinations {
                authorizations.resolve_known(destination)?;
            }
        }
        "delete" => {
            for source in &record.sources {
                authorizations.resolve_known(source)?;
            }
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
        "move" | "rename" | "copy" => {
            for source in &record.sources {
                authorizations.resolve(source)?;
            }
            // Write targets (the file is at `source` before the redo).
            for destination in &record.destinations {
                authorizations.resolve_known(destination)?;
            }
        }
        "delete" => {
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

/// Delete undo backups whose history entry has been evicted. The undo history
/// is bounded in the frontend, so every backup that outlives its entry is
/// unreachable garbage. Paths must live inside the app-data undo folder.
///
/// Async + spawn_blocking: a backup can be a full directory tree, and a
/// synchronous command would delete it on the UI thread, freezing the
/// desktop for seconds.
#[tauri::command]
pub async fn discard_undo_backups(
    app: tauri::AppHandle,
    backups: Vec<String>,
) -> Result<(), String> {
    let undo_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("undo");
    for backup in backups {
        let path = std::path::Path::new(&backup);
        // Component-wise containment: the backup must live inside the undo
        // folder (layout: undo/<uuid>/<index>) and must not smuggle `..` or
        // an extended prefix past the root.
        let Ok(relative) = path.strip_prefix(&undo_root) else {
            return Err("backup path is outside the undo folder".into());
        };
        let mut depth = 0usize;
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err("backup path is outside the undo folder".into());
            }
            depth += 1;
        }
        if depth == 0 || depth > 2 {
            return Err("backup path is outside the undo folder".into());
        }
        let path = path.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(&path);
            let _ = std::fs::remove_file(&path);
        })
        .await
        .map_err(|e| e.to_string())?;
    }
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

#[tauri::command]
pub fn toggle_show_desktop() -> Result<(), String> {
    crate::window_manager::toggle_show_desktop();
    Ok(())
}
