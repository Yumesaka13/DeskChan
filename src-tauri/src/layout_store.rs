//! Single owner of the session layout, its revision, and its TOML file.

use crate::config::{self, DeskConfig};
use crate::explorer_layout::ExplorerLayout;
use crate::{desktop, path_security};
use std::path::{Path, PathBuf};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

struct StoredLayout {
    revision: u64,
    value: DeskConfig,
}

pub struct LayoutStore {
    path: PathBuf,
    current: Mutex<StoredLayout>,
}

impl LayoutStore {
    pub fn open(app: &AppHandle, data_dir: &Path) -> (Self, Vec<PathBuf>) {
        let path = data_dir.join("deskchan.toml");
        let value = load_or_create(&path, || initial_layout(app));
        let icon_paths = config::config_icon_paths(&value);
        (
            Self {
                path,
                current: Mutex::new(StoredLayout { revision: 0, value }),
            },
            icon_paths,
        )
    }

    pub async fn snapshot(&self) -> DeskConfig {
        self.current.lock().await.value.clone()
    }

    pub async fn save(&self, value: DeskConfig, revision: u64) -> Result<(), String> {
        let mut current = self.current.lock().await;
        // Debounced renderer writes must never replace a newer layout.
        if revision > current.revision {
            self.persist(&mut current, value, revision)?;
        }
        Ok(())
    }

    pub async fn replace(&self, value: DeskConfig, revision: u64) -> Result<DeskConfig, String> {
        let mut current = self.current.lock().await;
        let revision = current.revision.max(revision);
        self.persist(&mut current, value, revision)?;
        Ok(current.value.clone())
    }

    fn persist(
        &self,
        current: &mut StoredLayout,
        value: DeskConfig,
        revision: u64,
    ) -> Result<(), String> {
        validate(&value)?;
        config::save_config(&self.path, &value).map_err(|error| error.to_string())?;
        *current = StoredLayout { revision, value };
        Ok(())
    }
}

fn validate(value: &DeskConfig) -> Result<(), String> {
    config::validate_config(value)?;
    path_security::validate_config_paths(value)
}

pub fn initial_layout(app: &AppHandle) -> DeskConfig {
    let layout = app
        .get_webview_window("main")
        .map(|window| ExplorerLayout::capture(&window))
        .unwrap_or_default();
    desktop::first_run_config(&layout)
}

fn load_or_create(path: &Path, create: impl FnOnce() -> DeskConfig) -> DeskConfig {
    match config::parse_config(path) {
        Ok(mut value) => {
            let migrated = migrate(&mut value);
            let repaired = if let Err(error) = config::validate_config(&value) {
                let repaired = config::repair_config(&mut value);
                if let Err(remaining) = config::validate_config(&value) {
                    eprintln!("DeskChan: layout is not repairable after {repaired} fixes: {error}; {remaining}");
                    return recover(path, create);
                }
                eprintln!("DeskChan: repaired {repaired} layout issue(s): {error}");
                true
            } else {
                false
            };
            if migrated || repaired {
                persist_at_startup(path, &value);
            }
            value
        }
        Err(_) if !path.exists() => {
            let value = create();
            persist_at_startup(path, &value);
            value
        }
        Err(error) => {
            eprintln!("DeskChan: could not load the layout: {error}");
            recover(path, create)
        }
    }
}

fn migrate(value: &mut DeskConfig) -> bool {
    if value.version >= 3 {
        return false;
    }
    for cell in value.cells.drain(..) {
        value.free_icons.extend(cell.icons);
        for sub in cell.sub_cells {
            value.free_icons.extend(sub.icons);
        }
    }
    value.version = 3;
    true
}

fn recover(path: &Path, create: impl FnOnce() -> DeskConfig) -> DeskConfig {
    let candidate = path.with_extension("toml.corrupt");
    let backup = if candidate.exists() {
        path.with_extension(format!("toml.corrupt-{}", uuid::Uuid::new_v4()))
    } else {
        candidate
    };
    let value = create();
    // Protect the user's damaged layout if it cannot be moved out of the way.
    match std::fs::rename(path, backup) {
        Ok(()) => persist_at_startup(path, &value),
        Err(error) => eprintln!("DeskChan: could not back up the damaged layout: {error}"),
    }
    value
}

fn persist_at_startup(path: &Path, value: &DeskConfig) {
    if let Err(error) = config::save_config(path, value) {
        // Keep the recovered layout usable in memory on a locked or full disk.
        eprintln!("DeskChan: could not save the initialized layout: {error}");
    }
}

pub fn export(app: &AppHandle, value: &DeskConfig) -> Result<bool, String> {
    validate(value)?;
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("TOML", &["toml"])
        .set_file_name("deskchan.toml")
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let selected = file.into_path().map_err(|error| error.to_string())?;
    let path = path_security::validate_toml_file(&selected.to_string_lossy(), false)?;
    config::save_config(&path, value).map_err(|error| error.to_string())?;
    Ok(true)
}

pub fn select_import(app: &AppHandle) -> Result<Option<DeskConfig>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("TOML", &["toml"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let selected = file.into_path().map_err(|error| error.to_string())?;
    let path = path_security::validate_toml_file(&selected.to_string_lossy(), true)?;
    let mut value = config::parse_config(&path).map_err(|error| error.to_string())?;
    migrate(&mut value);
    validate(&value)?;
    Ok(Some(value))
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use crate::config::DesktopIcon;

    #[test]
    fn captures_positions_once_and_keeps_the_saved_layout_on_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deskchan.toml");
        let initial = load_or_create(&path, || DeskConfig {
            free_icons: vec![DesktopIcon {
                id: "first-icon".into(),
                name: "Notes".into(),
                path: r"C:\Desktop\Notes.txt".into(),
                icon_path: None,
                pos_x: 307.5,
                pos_y: 94.0,
            }],
            ..DeskConfig::default()
        });
        assert_eq!(initial.free_icons[0].pos_x, 307.5);
        let reopened = load_or_create(&path, || panic!("an existing layout must not be reseeded"));
        assert_eq!(
            (reopened.free_icons[0].pos_x, reopened.free_icons[0].pos_y),
            (307.5, 94.0)
        );
    }
}
