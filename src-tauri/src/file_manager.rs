//! Minimal file management — move desktop files into managed storage and back.
//! Files are moved when dragged into cells, restored when removed or on exit.

use std::path::Path;

/// Move a file from `source` to `{app_data}/cell_files/{cell_id}/`.
/// Returns `(new_storage_path, original_path)`.
pub fn move_file(source: &Path, cell_id: &str, app_data: &Path) -> Result<(String, String), String> {
    let dest_dir = app_data.join("cell_files").join(cell_id);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let filename = source.file_name().ok_or("invalid source path")?;
    let dest = dest_dir.join(filename);

    if std::fs::rename(source, &dest).is_err() {
        std::fs::copy(source, &dest).map_err(|e| format!("copy: {e}"))?;
        std::fs::remove_file(source).map_err(|e| format!("remove: {e}"))?;
    }

    // Notify Explorer to refresh desktop immediately
    notify_shell(source);

    Ok((dest.to_string_lossy().to_string(), source.to_string_lossy().to_string()))
}

/// Move a file back from managed storage to its original location.
pub fn restore_file(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_err() {
        std::fs::copy(from, to).map_err(|e| format!("copy: {e}"))?;
        std::fs::remove_file(from).map_err(|e| format!("remove: {e}"))?;
    }
    // Notify Explorer to show the restored icon
    notify_shell(to);
    Ok(())
}

/// Force Windows Explorer to refresh a directory immediately.
#[cfg(target_os = "windows")]
fn notify_shell(path: &Path) {
    use std::os::windows::ffi::OsStrExt;

    const SHCNE_DELETE: i32 = 0x00000004;
    const SHCNE_UPDATEDIR: i32 = 0x00001000;
    const SHCNF_PATHW: i32 = 0x0005;
    const SHCNF_FLUSH: i32 = 0x1000;

    extern "system" {
        fn SHChangeNotify(event_id: i32, flags: i32, item1: *const u8, item2: *const u8);
    }

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        SHChangeNotify(SHCNE_DELETE, SHCNF_PATHW | SHCNF_FLUSH, wide.as_ptr() as _, std::ptr::null());
    }

    if let Some(parent) = path.parent() {
        let wide_p: Vec<u16> = parent.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW | SHCNF_FLUSH, wide_p.as_ptr() as _, std::ptr::null());
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn notify_shell(_path: &Path) {}
