//! Filesystem operations and reversible changes to desktop files.

use super::catalog::{display_name, user_desktop_dir};
use super::{FileMutation, FileOperation, FileUndoRecord, RenamedIconMutation};
use std::path::{Path, PathBuf};

/// Move a file or directory into the configured user desktop folder.
/// Avoids overwriting an existing entry by appending " (n)".
pub fn move_to_desktop(path: &str) -> Result<String, String> {
    let source = Path::new(path);
    if !source.exists() {
        return Err("source does not exist".into());
    }
    let destination = desktop_destination(source, true)?;
    if source == destination {
        return Ok(source.to_string_lossy().to_string());
    }

    match std::fs::rename(source, &destination) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(17) => {
            copy_entry(source, &destination)?;
            if source.is_dir() {
                std::fs::remove_dir_all(source).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_file(source).map_err(|e| e.to_string())?;
            }
        }
        Err(error) => return Err(error.to_string()),
    }
    Ok(destination.to_string_lossy().to_string())
}

/// Copy a file or directory into the configured user desktop folder.
pub fn copy_to_desktop(path: &str) -> Result<String, String> {
    let source = Path::new(path);
    if !source.exists() {
        return Err("source does not exist".into());
    }
    let destination = desktop_destination(source, false)?;
    copy_entry(source, &destination)?;
    Ok(destination.to_string_lossy().to_string())
}

fn desktop_destination(source: &Path, allow_same_path: bool) -> Result<PathBuf, String> {
    let desktop = user_desktop_dir();
    std::fs::create_dir_all(&desktop).map_err(|e| e.to_string())?;
    let filename = source.file_name().ok_or("invalid source")?;
    let direct = desktop.join(filename);
    #[cfg(target_os = "windows")]
    if allow_same_path && same_path_on_windows(source, &direct) {
        return Ok(direct);
    }
    #[cfg(not(target_os = "windows"))]
    if allow_same_path && source == direct {
        return Ok(direct);
    }
    if source.is_dir() && desktop.starts_with(source) {
        return Err("desktop folder cannot be moved into itself".into());
    }
    if !direct.exists() {
        return Ok(direct);
    }

    let stem = direct
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = direct
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for n in 1.. {
        let candidate = desktop.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    unreachable!()
}

pub fn copy_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_dir() {
        std::fs::create_dir(destination).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(source, destination).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

fn move_exact(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err("undo target already exists".into());
    }
    match std::fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(17) => {
            copy_entry(source, destination)?;
            remove_entry(source)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn validate_rename_label(label: &str) -> Result<(), String> {
    if label.is_empty() || label == "." || label == ".." {
        return Err("invalid file name".into());
    }
    if label.chars().any(|ch| {
        ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return Err("file name contains invalid characters".into());
    }
    Ok(())
}

fn same_filename_on_windows(left: &Path, right: &Path) -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (left, right);
        false
    }
    #[cfg(target_os = "windows")]
    {
        left.parent() == right.parent()
            && left
                .file_name()
                .zip(right.file_name())
                .is_some_and(|(left, right)| {
                    left.to_string_lossy()
                        .eq_ignore_ascii_case(&right.to_string_lossy())
                })
    }
}

/// Whole-path case-insensitive equality for Windows (the filesystem is
/// case-insensitive, but `PathBuf::eq` compares code units exactly). Without
/// this, moving a file that is already on the desktop with a differently
/// cased spelling (e.g. `C:\Users\me\desktop\a.txt`) was treated as a
/// different file and duplicated as "a (1).txt".
#[cfg(target_os = "windows")]
fn same_path_on_windows(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

pub fn rename_with_undo(
    source: &Path,
    new_label: &str,
    preserve_extension: bool,
) -> Result<RenamedIconMutation, String> {
    if !source.exists() {
        return Err("source does not exist".into());
    }
    let label = new_label.trim();
    validate_rename_label(label)?;
    let parent = source.parent().ok_or("invalid source")?;
    let filename = if preserve_extension && source.is_file() {
        match source.extension().and_then(|ext| ext.to_str()) {
            Some(ext) if !ext.is_empty() => format!("{label}.{ext}"),
            _ => label.to_string(),
        }
    } else {
        label.to_string()
    };
    validate_rename_label(&filename)?;
    let destination = parent.join(filename);
    if source == destination {
        return Ok(RenamedIconMutation {
            path: destination.to_string_lossy().to_string(),
            name: display_name(&destination, destination.is_dir()),
            record: FileUndoRecord {
                kind: FileOperation::Rename,
                sources: vec![source.to_string_lossy().to_string()],
                destinations: vec![destination.to_string_lossy().to_string()],
                backups: vec![],
            },
        });
    }
    if destination.exists() && !same_filename_on_windows(source, &destination) {
        return Err("target already exists".into());
    }
    std::fs::rename(source, &destination).map_err(|e| e.to_string())?;
    Ok(RenamedIconMutation {
        path: destination.to_string_lossy().to_string(),
        name: display_name(&destination, destination.is_dir()),
        record: FileUndoRecord {
            kind: FileOperation::Rename,
            sources: vec![source.to_string_lossy().to_string()],
            destinations: vec![destination.to_string_lossy().to_string()],
            backups: vec![],
        },
    })
}

pub fn move_to_desktop_with_undo(path: &str) -> Result<FileMutation, String> {
    let source = PathBuf::from(path);
    let destination = PathBuf::from(move_to_desktop(path)?);
    Ok(FileMutation {
        paths: vec![destination.to_string_lossy().to_string()],
        record: FileUndoRecord {
            kind: FileOperation::Move,
            sources: vec![source.to_string_lossy().to_string()],
            destinations: vec![destination.to_string_lossy().to_string()],
            backups: vec![],
        },
    })
}

pub fn delete_with_undo(paths: &[PathBuf], backup_root: &Path) -> Result<FileMutation, String> {
    if paths.is_empty() {
        return Err("no files to delete".into());
    }
    std::fs::create_dir_all(backup_root).map_err(|e| e.to_string())?;
    let mut backups = Vec::with_capacity(paths.len());
    for (index, path) in paths.iter().enumerate() {
        let backup = backup_root.join(index.to_string());
        if let Err(error) = copy_entry(path, &backup) {
            // A partial backup tree is unreachable garbage - no history entry
            // is created for a failed delete, so nothing would ever clean it.
            let _ = std::fs::remove_dir_all(backup_root);
            return Err(error);
        }
        backups.push(backup.to_string_lossy().to_string());
    }
    if let Err(error) = recycle_paths(paths) {
        // Recycle cancelled/failed (the file still exists): the copy made
        // above is already redundant, remove it instead of leaking it.
        let _ = std::fs::remove_dir_all(backup_root);
        return Err(error);
    }
    Ok(FileMutation {
        paths: vec![],
        record: FileUndoRecord {
            kind: FileOperation::Delete,
            sources: paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            destinations: vec![],
            backups,
        },
    })
}

pub fn delete_permanently_with_undo(
    paths: &[PathBuf],
    backup_root: &Path,
) -> Result<FileMutation, String> {
    if paths.is_empty() {
        return Err("no files to delete".into());
    }
    std::fs::create_dir_all(backup_root).map_err(|e| e.to_string())?;
    let mut backups = Vec::with_capacity(paths.len());
    for (index, path) in paths.iter().enumerate() {
        let backup = backup_root.join(index.to_string());
        if let Err(error) = copy_entry(path, &backup) {
            let _ = std::fs::remove_dir_all(backup_root);
            return Err(error);
        }
        backups.push(backup.to_string_lossy().to_string());
    }
    if let Err(error) = delete_paths(paths) {
        let _ = std::fs::remove_dir_all(backup_root);
        return Err(error);
    }
    Ok(FileMutation {
        paths: vec![],
        record: FileUndoRecord {
            kind: FileOperation::DeletePermanent,
            sources: paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            destinations: vec![],
            backups,
        },
    })
}

fn delete_paths(paths: &[PathBuf]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;

        const FO_DELETE: u32 = 3;
        #[repr(C)]
        struct ShFileOp {
            hwnd: isize,
            func: u32,
            from: *const u16,
            to: *const u16,
            flags: u16,
            aborted: i32,
            mappings: *mut c_void,
            progress_title: *const u16,
        }
        extern "system" {
            fn SHFileOperationW(operation: *mut ShFileOp) -> i32;
        }

        let mut from = Vec::new();
        for path in paths {
            from.extend(path.as_os_str().to_string_lossy().encode_utf16());
            from.push(0);
        }
        from.push(0);
        let mut operation = ShFileOp {
            hwnd: 0,
            func: FO_DELETE,
            from: from.as_ptr(),
            to: std::ptr::null(),
            flags: 0,
            aborted: 0,
            mappings: std::ptr::null_mut(),
            progress_title: std::ptr::null(),
        };
        let result = unsafe { SHFileOperationW(&mut operation) };
        if result != 0 || operation.aborted != 0 {
            return Err("delete operation was cancelled or failed".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        for path in paths {
            remove_entry(path)?;
        }
        Ok(())
    }
}

pub fn undo_file_operation(record: &FileUndoRecord) -> Result<(), String> {
    match record.kind {
        FileOperation::Move | FileOperation::Rename => {
            for (source, destination) in record.sources.iter().zip(&record.destinations) {
                move_exact(Path::new(destination), Path::new(source))?;
            }
        }
        FileOperation::Copy => {
            for destination in &record.destinations {
                remove_entry(Path::new(destination))?;
            }
        }
        FileOperation::Delete | FileOperation::DeletePermanent => {
            for (source, backup) in record.sources.iter().zip(&record.backups) {
                let source = Path::new(source);
                if source.exists() {
                    return Err("cannot restore over an existing file".into());
                }
                copy_entry(Path::new(backup), source)?;
            }
        }
    }
    Ok(())
}

pub fn redo_file_operation(record: &FileUndoRecord) -> Result<(), String> {
    match record.kind {
        FileOperation::Move | FileOperation::Rename => {
            for (source, destination) in record.sources.iter().zip(&record.destinations) {
                move_exact(Path::new(source), Path::new(destination))?;
            }
        }
        FileOperation::Copy => {
            for (source, destination) in record.sources.iter().zip(&record.destinations) {
                copy_entry(Path::new(source), Path::new(destination))?;
            }
        }
        FileOperation::Delete => {
            recycle_paths(&record.sources.iter().map(PathBuf::from).collect::<Vec<_>>())?
        }
        FileOperation::DeletePermanent => {
            for source in &record.sources {
                remove_entry(Path::new(source))?;
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn recycle_paths(paths: &[PathBuf]) -> Result<(), String> {
    use std::ffi::c_void;

    const FO_DELETE: u32 = 3;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    #[repr(C)]
    struct ShFileOp {
        hwnd: isize,
        func: u32,
        from: *const u16,
        to: *const u16,
        flags: u16,
        aborted: i32,
        mappings: *mut c_void,
        progress_title: *const u16,
    }
    extern "system" {
        fn SHFileOperationW(operation: *mut ShFileOp) -> i32;
    }

    let mut from = Vec::new();
    for path in paths {
        from.extend(path.as_os_str().to_string_lossy().encode_utf16());
        from.push(0);
    }
    from.push(0);
    let mut operation = ShFileOp {
        hwnd: 0,
        func: FO_DELETE,
        from: from.as_ptr(),
        to: std::ptr::null(),
        flags: FOF_ALLOWUNDO,
        aborted: 0,
        mappings: std::ptr::null_mut(),
        progress_title: std::ptr::null(),
    };
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 || operation.aborted != 0 {
        return Err("delete operation was cancelled or failed".into());
    }
    Ok(())
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn same_path_on_windows_is_case_insensitive() {
        assert!(same_path_on_windows(
            Path::new(r"C:\Users\Me\desktop\a.txt"),
            Path::new(r"C:\Users\Me\Desktop\A.TXT"),
        ));
        assert!(!same_path_on_windows(
            Path::new(r"C:\Users\Me\Desktop\a.txt"),
            Path::new(r"D:\Users\Me\Desktop\a.txt"),
        ));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn same_path_on_windows_compiles_elsewhere() {}
}
