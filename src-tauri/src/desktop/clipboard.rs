//! Explorer-compatible CF_HDROP and Preferred DropEffect handling.

#[cfg(target_os = "windows")]
use super::files::{copy_to_desktop, move_to_desktop};
use super::FileMutation;
#[cfg(target_os = "windows")]
use super::{FileOperation, FileUndoRecord};
#[cfg(target_os = "windows")]
use std::path::PathBuf;

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
                kind: if move_files {
                    FileOperation::Move
                } else {
                    FileOperation::Copy
                },
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
