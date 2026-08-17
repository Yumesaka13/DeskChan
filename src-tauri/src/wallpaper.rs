use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
mod win32 {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr;

    pub type DWORD = u32;
    pub type HRESULT = i32;
    pub type HKEY = *mut c_void;
    pub type LPBYTE = *mut u8;
    pub type LSTATUS = i32;

    pub const HKEY_CURRENT_USER: HKEY = -2147483647isize as HKEY;
    pub const KEY_READ: DWORD = 0x20019;
    pub const SPI_GETDESKWALLPAPER: u32 = 0x0073;

    extern "system" {
        pub fn SystemParametersInfoW(uiAction: u32, uiParam: u32, pvParam: *mut c_void, fWinIni: u32) -> i32;
        pub fn RegOpenKeyExW(
            hKey: HKEY,
            lpSubKey: *const u16,
            ulOptions: DWORD,
            samDesired: DWORD,
            phkResult: *mut HKEY,
        ) -> LSTATUS;
        pub fn RegQueryValueExW(
            hKey: HKEY,
            lpValueName: *const u16,
            lpReserved: *mut DWORD,
            lpType: *mut DWORD,
            lpData: LPBYTE,
            lpcbData: *mut DWORD,
        ) -> LSTATUS;
        pub fn RegCloseKey(hKey: HKEY) -> LSTATUS;
        pub fn DwmGetColorizationColor(pcrColorization: *mut DWORD, pfOpaqueBlend: *mut bool) -> HRESULT;
    }

    pub fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn read_registry_wallpaper() -> Option<String> {
        let key_name = wide("Control Panel\\Desktop");
        let mut key: HKEY = ptr::null_mut();
        let result = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, key_name.as_ptr(), 0, KEY_READ, &mut key) };
        if result != 0 || key.is_null() {
            return None;
        }

        let value_name = wide("Wallpaper");
        let mut value_type: DWORD = 0;
        let mut value_size: DWORD = 0;
        let status = unsafe {
            RegQueryValueExW(
                key,
                value_name.as_ptr(),
                ptr::null_mut(),
                &mut value_type,
                ptr::null_mut(),
                &mut value_size,
            )
        };
        if status != 0 || value_size == 0 {
            unsafe { RegCloseKey(key) };
            return None;
        }

        let mut raw = vec![0u8; value_size as usize];
        let query = unsafe {
            RegQueryValueExW(
                key,
                value_name.as_ptr(),
                ptr::null_mut(),
                &mut value_type,
                raw.as_mut_ptr() as LPBYTE,
                &mut value_size,
            )
        };
        unsafe { RegCloseKey(key) };
        if query != 0 {
            return None;
        }

        let byte_len = raw.iter().position(|&byte| byte == 0).unwrap_or(raw.len()) / 2;
        let chars = raw[..byte_len * 2]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let value = String::from_utf16_lossy(&chars);
        let path = PathBuf::from(value);
        if path.is_absolute() && path.exists() {
            Some(path.to_string_lossy().to_string())
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn current_wallpaper_path() -> Option<String> {
    let mut buffer = vec![0u16; 260];
    let result = unsafe {
        win32::SystemParametersInfoW(
            win32::SPI_GETDESKWALLPAPER,
            buffer.len() as u32,
            buffer.as_mut_ptr().cast(),
            0,
        )
    };
    if result == 0 {
        return win32::read_registry_wallpaper();
    }

    let len = buffer.iter().position(|&item| item == 0).unwrap_or(buffer.len());
    let path = String::from_utf16_lossy(&buffer[..len]);
    let path = PathBuf::from(path);
    if path.is_absolute() && path.exists() {
        Some(path.to_string_lossy().to_string())
    } else {
        win32::read_registry_wallpaper()
    }
}

#[cfg(not(target_os = "windows"))]
fn current_wallpaper_path() -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn builtin_wallpaper_color() -> Option<(u8, u8, u8)> {
    let mut color = 0u32;
    let mut opaque = false;
    let hr = unsafe { win32::DwmGetColorizationColor(&mut color, &mut opaque) };
    if hr != 0 {
        return None;
    }
    let r = ((color >> 16) & 0xFF) as u8;
    let g = ((color >> 8) & 0xFF) as u8;
    let b = (color & 0xFF) as u8;
    Some((r, g, b))
}

#[cfg(not(target_os = "windows"))]
fn builtin_wallpaper_color() -> Option<(u8, u8, u8)> {
    None
}

#[allow(dead_code)]
fn average_image_color(path: &Path) -> Option<(u8, u8, u8)> {
    let image = image::open(path).ok()?;
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 {
        return None;
    }

    const SAMPLE_STEP: u32 = 4;
    let mut r: u64 = 0;
    let mut g: u64 = 0;
    let mut b: u64 = 0;
    let mut count: u64 = 0;

    for y in (0..height).step_by(SAMPLE_STEP as usize) {
        for x in (0..width).step_by(SAMPLE_STEP as usize) {
            let pixel = rgba.get_pixel(x, y);
            if pixel[3] == 0 {
                continue;
            }
            r += u64::from(pixel[0]);
            g += u64::from(pixel[1]);
            b += u64::from(pixel[2]);
            count += 1;
        }
    }

    if count == 0 {
        return None;
    }

    Some(((r / count) as u8, (g / count) as u8, (b / count) as u8))
}

#[allow(dead_code)]
fn rgb_to_hex((r, g, b): (u8, u8, u8)) -> String {
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

#[tauri::command]
pub fn get_wallpaper_color() -> Result<String, String> {
    let color = builtin_wallpaper_color().or_else(|| {
        let path = current_wallpaper_path()?;
        average_image_color(Path::new(&path))
    });

    let Some((r, g, b)) = color else {
        return Err("wallpaper color unavailable".into());
    };
    Ok(rgb_to_hex((r, g, b)))
}
