//! Validation for renderer-supplied filesystem paths.
//!
//! Desktop shortcuts may point at arbitrary local files, but never at remote
//! shares or Windows device namespaces. Validate every path before passing it
//! to the Windows shell or filesystem APIs.

use crate::config::DeskConfig;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

const INVALID_PATH: &str = "path must be an absolute local filesystem path";

#[derive(Default)]
pub struct PathAuthorizations {
    paths: RwLock<HashMap<String, PathBuf>>,
}

impl PathAuthorizations {
    pub fn authorize(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut authorized = self
            .paths
            .write()
            .expect("path authorization lock poisoned");
        for path in paths {
            if let Ok(path) = validate_existing_local_path(&path.to_string_lossy()) {
                authorized.insert(path_key(&path), path);
            }
        }
    }

    pub fn resolve(&self, value: &str) -> Result<PathBuf, String> {
        let path = validate_existing_local_path(value)?;
        self.paths
            .read()
            .expect("path authorization lock poisoned")
            .get(&path_key(&path))
            .cloned()
            .ok_or_else(|| "path was not authorized by a desktop scan or native file drop".into())
    }
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

fn is_windows_drive_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// Reject UNC paths, device namespaces, drive-relative paths, and URL-like
/// values before any shell API receives them.
pub fn validate_local_path(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty()
        || value.starts_with("//")
        || value.starts_with("\\??\\")
        || value.contains('\0')
    {
        return Err(INVALID_PATH.into());
    }

    // `\\?\C:\...` is the extended spelling Windows returns after
    // canonicalization. It is accepted only for a local drive path, then
    // normalized back to the ordinary drive spelling before shell access.
    let value = if let Some(value) = value.strip_prefix(r"\\?\") {
        if value.starts_with("UNC\\") || value.starts_with("unc\\") {
            return Err(INVALID_PATH.into());
        }
        value
    } else {
        if value.starts_with("\\\\") {
            return Err(INVALID_PATH.into());
        }
        value
    };

    let path = PathBuf::from(value);
    if !(path.is_absolute() || is_windows_drive_absolute(value)) {
        return Err(INVALID_PATH.into());
    }
    Ok(path)
}

/// Canonicalize an existing local path so reparse points are resolved before it
/// reaches the shell. Canonical output is checked again in case resolution
/// changes its namespace.
pub fn validate_existing_local_path(value: &str) -> Result<PathBuf, String> {
    let path = validate_local_path(value)?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("invalid path: {e}"))?;
    let canonical = strip_extended_drive_prefix(canonical)?;
    validate_local_path(&canonical.to_string_lossy())?;
    Ok(canonical)
}

fn strip_extended_drive_prefix(path: PathBuf) -> Result<PathBuf, String> {
    let value = path.to_string_lossy();
    let Some(value) = value.strip_prefix(r"\\?\") else {
        return Ok(path);
    };
    if is_windows_drive_absolute(value) {
        Ok(PathBuf::from(value))
    } else {
        Err(INVALID_PATH.into())
    }
}

/// Validate an output path without requiring the file itself to exist. Its
/// parent must exist and be local after canonicalization; this prevents a
/// relative path from escaping through a junction or symlinked parent.
pub fn validate_local_output_path(value: &str) -> Result<PathBuf, String> {
    let path = validate_local_path(value)?;
    let filename = path.file_name().ok_or_else(|| INVALID_PATH.to_string())?;
    let parent = path.parent().ok_or_else(|| INVALID_PATH.to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("invalid output directory: {e}"))?;
    validate_local_path(&canonical_parent.to_string_lossy())?;
    Ok(canonical_parent.join(filename))
}

pub fn validate_toml_file(path: &str, must_exist: bool) -> Result<PathBuf, String> {
    let path = if must_exist {
        validate_existing_local_path(path)?
    } else {
        validate_local_output_path(path)?
    };
    if !path.is_file() && must_exist {
        return Err("configuration import must be a file".into());
    }
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("toml"))
    {
        return Err("configuration files must use the .toml extension".into());
    }
    Ok(path)
}

/// Config files are renderer-controlled input. Permit arbitrary local desktop
/// targets, but prevent a saved/imported config from reintroducing blocked
/// shell namespaces later.
pub fn validate_config_paths(cfg: &DeskConfig) -> Result<(), String> {
    let icons = cfg
        .free_icons
        .iter()
        .chain(cfg.cells.iter().flat_map(|cell| cell.icons.iter()))
        .chain(
            cfg.cells
                .iter()
                .flat_map(|cell| cell.sub_cells.iter().flat_map(|sub| sub.icons.iter())),
        );

    for icon in icons {
        validate_local_path(&icon.path)?;
        if let Some(icon_path) = &icon.icon_path {
            validate_local_path(icon_path)?;
        }
    }
    for path in &cfg.excluded_from_organize {
        validate_local_path(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_network_and_device_namespaces() {
        for value in [
            r"\\server\share\file.txt",
            r"\\?\UNC\server\share\file.txt",
            r"\\.\PhysicalDrive0",
            r"\??\C:\Windows\System32",
            "//server/share/file.txt",
        ] {
            assert!(
                validate_local_path(value).is_err(),
                "{value} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_relative_and_drive_relative_paths() {
        for value in [
            "file.txt",
            r"..\file.txt",
            r"C:file.txt",
            "https://example.test",
        ] {
            assert!(
                validate_local_path(value).is_err(),
                "{value} must be rejected"
            );
        }
    }

    #[test]
    fn permits_local_drive_paths() {
        assert_eq!(
            validate_local_path(r"C:\Users\Alice\Desktop\file.txt").unwrap(),
            PathBuf::from(r"C:\Users\Alice\Desktop\file.txt")
        );
    }
}
