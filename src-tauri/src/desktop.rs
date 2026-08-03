//! Desktop folder helpers: enumeration, filtering, and change watching.
//!
//! Single source of truth for "what appears as a desktop icon" - the JS side
//! must not re-filter. Like the native shell, the user desktop is merged with
//! the public desktop (C:\Users\Public\Desktop, where installers put
//! all-users shortcuts).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A filesystem mutation that DeskChan can reverse during this session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUndoRecord {
    pub kind: String,
    pub sources: Vec<String>,
    pub destinations: Vec<String>,
    pub backups: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileMutation {
    pub paths: Vec<String>,
    pub record: FileUndoRecord,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenamedIconMutation {
    pub path: String,
    pub name: String,
    pub record: FileUndoRecord,
}

#[cfg(target_os = "windows")]
const FOLDERID_DESKTOP: crate::win32::Guid = crate::win32::Guid {
    d1: 0xb4bfcc3a,
    d2: 0xdb2c,
    d3: 0x424c,
    d4: [0xb0, 0x29, 0x7f, 0xe9, 0x9a, 0x87, 0xc6, 0x41],
};

#[cfg(target_os = "windows")]
fn configured_desktop_dir() -> Option<PathBuf> {
    use std::ffi::c_void;

    extern "system" {
        fn SHGetKnownFolderPath(
            rfid: *const crate::win32::Guid,
            flags: u32,
            token: isize,
            path: *mut *mut u16,
        ) -> i32;
        fn CoTaskMemFree(ptr: *mut c_void);
    }

    let _com = crate::win32::ComGuard::init();
    let mut raw_path: *mut u16 = std::ptr::null_mut();
    let result = unsafe { SHGetKnownFolderPath(&FOLDERID_DESKTOP, 0, 0, &mut raw_path) };
    if result < 0 || raw_path.is_null() {
        return None;
    }

    let len = unsafe { (0..).take_while(|&i| *raw_path.add(i) != 0).count() };
    let path = PathBuf::from(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(raw_path, len)
    }));
    unsafe { CoTaskMemFree(raw_path.cast()) };
    Some(path)
}

/// The user's own desktop folder (write target for `copy_to_desktop`).
pub fn user_desktop_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = configured_desktop_dir() {
            return path;
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Desktop");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join("Desktop");
    }
    PathBuf::from(".")
}

/// All folders whose contents appear as desktop icons (user + public).
pub fn desktop_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![user_desktop_dir()];
    #[cfg(target_os = "windows")]
    {
        let public = std::env::var("PUBLIC")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"C:\Users\Public"))
            .join("Desktop");
        if public.is_dir() {
            dirs.push(public);
        }
    }
    dirs
}

/// Whether a directory entry should appear as a desktop icon.
fn is_visible(path: &Path, name: &str) -> bool {
    if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") {
        return false;
    }

    // read_dir returns filesystem entries that Explorer deliberately omits.
    // In particular, anti-ransomware products place hidden/system canary
    // junctions on the Public Desktop. Inspect the entry itself rather than
    // following a reparse point to its shared bait directory.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            let attributes = metadata.file_attributes();
            if attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0 {
                return false;
            }
        }
    }

    true
}

/// List all visible desktop entries as (path, is_dir). Folders first, then
/// apps, then other files, each group sorted by name - close to the native
/// default sort order.
pub fn list_entries() -> Vec<(PathBuf, bool)> {
    let mut folders = Vec::new();
    let mut apps = Vec::new();
    let mut files = Vec::new();
    for dir in desktop_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_visible(&path, name) {
                continue;
            }
            if path.is_dir() {
                folders.push(path);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(crate::config::is_app_extension)
            {
                apps.push(path);
            } else {
                files.push(path);
            }
        }
    }
    let by_name = |p: &PathBuf| p.file_name().map(|s| s.to_string_lossy().to_lowercase());
    folders.sort_by_key(by_name);
    apps.sort_by_key(by_name);
    files.sort_by_key(by_name);
    folders
        .into_iter()
        .map(|p| (p, true))
        .chain(apps.into_iter().chain(files).map(|p| (p, false)))
        .collect()
}

/// Build a DesktopIcon for a desktop entry. Position uses the -1 sentinel:
/// the frontend assigns the first free grid slot on reconcile.
pub fn make_icon(path: &Path, is_dir: bool) -> crate::config::DesktopIcon {
    let display = display_name(path, is_dir);
    crate::config::DesktopIcon {
        id: uuid::Uuid::new_v4().to_string(),
        name: display,
        path: path.to_string_lossy().to_string(),
        icon_path: None,
        pos_x: -1.0,
        pos_y: -1.0,
    }
}

pub fn display_name(path: &Path, is_dir: bool) -> String {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("?");
    // Folders keep their full name; files hide the extension (like Explorer)
    if is_dir {
        name.to_string()
    } else {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(name)
            .to_string()
    }
}

/// The config DeskChan creates on its very first run: default settings, no
/// cells, and every current desktop file as a free icon (sentinel -1
/// positions; the frontend assigns grid slots on reconcile). Also what
/// "reset config" restores.
pub fn first_run_config() -> crate::config::DeskConfig {
    crate::config::DeskConfig {
        free_icons: list_entries()
            .into_iter()
            .map(|(path, is_dir)| make_icon(&path, is_dir))
            .collect(),
        ..crate::config::DeskConfig::default()
    }
}

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
                kind: "rename".into(),
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
            kind: "rename".into(),
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
            kind: "move".into(),
            sources: vec![source.to_string_lossy().to_string()],
            destinations: vec![destination.to_string_lossy().to_string()],
            backups: vec![],
        },
    })
}

/// Paste local files from the Windows clipboard into the configured desktop.
/// `auto` follows Explorer's copy/cut marker; callers can force `copy` or
/// `move` through the context menu.
pub fn paste_from_clipboard(mode: &str) -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let (paths, preferred_move) = clipboard_file_paths()?;
        let move_files = match mode {
            "copy" => false,
            "move" => true,
            "auto" => preferred_move,
            _ => return Err("unsupported paste mode".into()),
        };
        paths
            .into_iter()
            .map(|path| {
                let path =
                    crate::path_security::validate_existing_local_path(&path.to_string_lossy())?;
                let output = if move_files {
                    move_to_desktop(&path.to_string_lossy())?
                } else {
                    copy_to_desktop(&path.to_string_lossy())?
                };
                Ok(output)
            })
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = mode;
        Err("clipboard file paste is only supported on Windows".into())
    }
}

pub fn paste_from_clipboard_with_undo(mode: &str) -> Result<FileMutation, String> {
    #[cfg(target_os = "windows")]
    {
        let (paths, preferred_move) = clipboard_file_paths()?;
        let move_files = match mode {
            "copy" => false,
            "move" => true,
            "auto" => preferred_move,
            _ => return Err("unsupported paste mode".into()),
        };
        let mut sources = Vec::new();
        let mut destinations = Vec::new();
        for path in paths {
            let source =
                crate::path_security::validate_existing_local_path(&path.to_string_lossy())?;
            let destination = if move_files {
                move_to_desktop(&source.to_string_lossy())?
            } else {
                copy_to_desktop(&source.to_string_lossy())?
            };
            sources.push(source.to_string_lossy().to_string());
            destinations.push(destination);
        }
        Ok(FileMutation {
            paths: destinations.clone(),
            record: FileUndoRecord {
                kind: if move_files { "move" } else { "copy" }.into(),
                sources,
                destinations,
                backups: vec![],
            },
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = mode;
        Err("clipboard file paste is only supported on Windows".into())
    }
}

pub fn delete_with_undo(paths: &[PathBuf], backup_root: &Path) -> Result<FileMutation, String> {
    if paths.is_empty() {
        return Err("no files to delete".into());
    }
    std::fs::create_dir_all(backup_root).map_err(|e| e.to_string())?;
    let mut backups = Vec::with_capacity(paths.len());
    for (index, path) in paths.iter().enumerate() {
        let backup = backup_root.join(index.to_string());
        copy_entry(path, &backup)?;
        backups.push(backup.to_string_lossy().to_string());
    }
    recycle_paths(paths)?;
    Ok(FileMutation {
        paths: vec![],
        record: FileUndoRecord {
            kind: "delete".into(),
            sources: paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            destinations: vec![],
            backups,
        },
    })
}

pub fn undo_file_operation(record: &FileUndoRecord) -> Result<(), String> {
    match record.kind.as_str() {
        "move" | "rename" => {
            for (source, destination) in record.sources.iter().zip(&record.destinations) {
                move_exact(Path::new(destination), Path::new(source))?;
            }
        }
        "copy" => {
            for destination in &record.destinations {
                remove_entry(Path::new(destination))?;
            }
        }
        "delete" => {
            for (source, backup) in record.sources.iter().zip(&record.backups) {
                let source = Path::new(source);
                if source.exists() {
                    return Err("cannot restore over an existing file".into());
                }
                copy_entry(Path::new(backup), source)?;
            }
        }
        _ => return Err("unsupported history operation".into()),
    }
    Ok(())
}

pub fn redo_file_operation(record: &FileUndoRecord) -> Result<(), String> {
    match record.kind.as_str() {
        "move" | "rename" => {
            for (source, destination) in record.sources.iter().zip(&record.destinations) {
                move_exact(Path::new(source), Path::new(destination))?;
            }
        }
        "copy" => {
            for (source, destination) in record.sources.iter().zip(&record.destinations) {
                copy_entry(Path::new(source), Path::new(destination))?;
            }
        }
        "delete" => recycle_paths(&record.sources.iter().map(PathBuf::from).collect::<Vec<_>>())?,
        _ => return Err("unsupported history operation".into()),
    }
    Ok(())
}

/// Put local files on the Windows clipboard for Explorer-compatible Copy/Cut.
/// The `Preferred DropEffect` marker is what lets a later paste distinguish a
/// cut from a copy.
#[cfg(target_os = "windows")]
pub fn copy_paths_to_clipboard(paths: &[PathBuf], cut: bool) -> Result<(), String> {
    use std::ffi::c_void;

    const CF_HDROP: u32 = 15;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const DROP_EFFECT_COPY: u32 = 1;
    const DROP_EFFECT_MOVE: u32 = 2;

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        x: i32,
        y: i32,
        f_nc: i32,
        f_wide: i32,
    }

    extern "system" {
        fn OpenClipboard(window: isize) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, memory: isize) -> isize;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
        fn GlobalAlloc(flags: u32, bytes: usize) -> isize;
        fn GlobalLock(memory: isize) -> *mut c_void;
        fn GlobalUnlock(memory: isize) -> i32;
        fn GlobalFree(memory: isize) -> isize;
    }

    if paths.is_empty() {
        return Err("no files selected".into());
    }
    let mut names = Vec::new();
    for path in paths {
        names.extend(path.as_os_str().to_string_lossy().encode_utf16());
        names.push(0);
    }
    names.push(0); // CF_HDROP requires a double-NUL terminated list.
    let bytes = std::mem::size_of::<DropFiles>() + names.len() * std::mem::size_of::<u16>();

    if unsafe { OpenClipboard(0) } == 0 {
        return Err("clipboard is busy".into());
    }
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }
    let _clipboard = ClipboardGuard;
    if unsafe { EmptyClipboard() } == 0 {
        return Err("could not clear clipboard".into());
    }

    let drop = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
    if drop == 0 {
        return Err("could not allocate clipboard data".into());
    }
    unsafe {
        let ptr = GlobalLock(drop) as *mut u8;
        if ptr.is_null() {
            GlobalFree(drop);
            return Err("could not lock clipboard data".into());
        }
        (ptr as *mut DropFiles).write(DropFiles {
            p_files: std::mem::size_of::<DropFiles>() as u32,
            x: 0,
            y: 0,
            f_nc: 0,
            f_wide: 1,
        });
        std::ptr::copy_nonoverlapping(
            names.as_ptr() as *const u8,
            ptr.add(std::mem::size_of::<DropFiles>()),
            names.len() * std::mem::size_of::<u16>(),
        );
        GlobalUnlock(drop);
        if SetClipboardData(CF_HDROP, drop) == 0 {
            GlobalFree(drop);
            return Err("could not set clipboard data".into());
        }
    }

    let effect =
        unsafe { RegisterClipboardFormatW(crate::win32::wide("Preferred DropEffect").as_ptr()) };
    let effect_memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, std::mem::size_of::<u32>()) };
    if effect == 0 || effect_memory == 0 {
        return Ok(()); // The file list is still a valid copy operation.
    }
    unsafe {
        let ptr = GlobalLock(effect_memory) as *mut u32;
        if ptr.is_null() {
            GlobalFree(effect_memory);
            return Ok(());
        }
        ptr.write(if cut {
            DROP_EFFECT_MOVE
        } else {
            DROP_EFFECT_COPY
        });
        GlobalUnlock(effect_memory);
        if SetClipboardData(effect, effect_memory) == 0 {
            GlobalFree(effect_memory);
        }
    }
    Ok(())
}

/// Delete files through Explorer so Windows sends them to the Recycle Bin.
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

#[cfg(target_os = "windows")]
fn clipboard_file_paths() -> Result<(Vec<PathBuf>, bool), String> {
    use std::ffi::c_void;

    const CF_HDROP: u32 = 15;
    const DROP_EFFECT_MOVE: u32 = 2;
    extern "system" {
        fn OpenClipboard(window: isize) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> isize;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
        fn GlobalLock(memory: isize) -> *mut c_void;
        fn GlobalUnlock(memory: isize) -> i32;
        fn DragQueryFileW(drop: isize, index: u32, path: *mut u16, length: u32) -> u32;
    }

    if unsafe { OpenClipboard(0) } == 0 {
        return Err("clipboard is busy".into());
    }
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }
    let _clipboard = ClipboardGuard;

    let drop = unsafe { GetClipboardData(CF_HDROP) };
    if drop == 0 {
        return Err("clipboard does not contain files or folders".into());
    }
    let count = unsafe { DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0) };
    if count == 0 {
        return Err("clipboard does not contain files or folders".into());
    }
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let len = unsafe { DragQueryFileW(drop, index, std::ptr::null_mut(), 0) };
        let mut buffer = vec![0u16; len as usize + 1];
        unsafe { DragQueryFileW(drop, index, buffer.as_mut_ptr(), buffer.len() as u32) };
        paths.push(PathBuf::from(String::from_utf16_lossy(
            &buffer[..len as usize],
        )));
    }

    let format_name = crate::win32::wide("Preferred DropEffect");
    let effect_format = unsafe { RegisterClipboardFormatW(format_name.as_ptr()) };
    let effect_data = unsafe { GetClipboardData(effect_format) };
    let preferred_move = if effect_data == 0 {
        false
    } else {
        let pointer = unsafe { GlobalLock(effect_data) } as *const u32;
        if pointer.is_null() {
            false
        } else {
            let effect = unsafe { *pointer };
            unsafe { GlobalUnlock(effect_data) };
            effect & DROP_EFFECT_MOVE != 0
        }
    };
    Ok((paths, preferred_move))
}

/// Watch the desktop folders and emit a debounced `desktop-changed` event so
/// the frontend can reconcile its icon list (add new files, drop deleted
/// ones). Fixes the "dropping a file on the desktop never refreshes" bug -
/// previously nothing observed the folder at all.
pub fn start_watcher(app: tauri::AppHandle) {
    use notify::{recommended_watcher, RecursiveMode, Watcher};
    use tauri::Emitter;

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = match recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    }) {
        Ok(w) => w,
        Err(_) => return, // no watcher -> manual refresh still works
    };
    for dir in desktop_dirs() {
        let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
    }
    std::thread::spawn(move || {
        let _watcher = watcher; // keep the watcher alive for the app's lifetime
        while rx.recv().is_ok() {
            // Debounce: a file copy fires many events in a burst; wait until
            // the folder has been quiet for 300ms before notifying JS.
            while rx
                .recv_timeout(std::time::Duration::from_millis(300))
                .is_ok()
            {}
            let _ = app.emit("desktop-changed", ());
        }
    });
}
