#[cfg(target_os = "windows")]
mod windows {
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::SystemTime;
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    type Rgb = [u8; 3];
    type ImageKey = (PathBuf, SystemTime, u64);
    static CACHE: Mutex<Option<(ImageKey, Option<Rgb>)>> = Mutex::new(None);

    extern "system" {
        fn SystemParametersInfoW(
            action: u32,
            parameter: u32,
            value: *mut c_void,
            flags: u32,
        ) -> i32;
        fn GetSysColor(index: i32) -> u32;
    }

    fn wallpaper_path() -> Option<PathBuf> {
        const SPI_GETDESKWALLPAPER: u32 = 0x0073;
        let mut buffer = vec![0u16; 32768];
        if unsafe {
            SystemParametersInfoW(
                SPI_GETDESKWALLPAPER,
                buffer.len() as u32,
                buffer.as_mut_ptr().cast(),
                0,
            )
        } != 0
        {
            let length = buffer
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(buffer.len());
            let path = PathBuf::from(OsString::from_wide(&buffer[..length]));
            if path.is_absolute() && path.is_file() {
                return Some(path);
            }
        }
        let path: OsString = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Control Panel\Desktop")
            .ok()?
            .get_value("Wallpaper")
            .ok()?;
        let path = PathBuf::from(path);
        (path.is_absolute() && path.is_file()).then_some(path)
    }

    fn image_color(path: PathBuf) -> Option<Rgb> {
        let metadata = path.metadata().ok()?;
        let key = (path, metadata.modified().ok()?, metadata.len());
        let mut cache = CACHE.lock().ok()?;
        if let Some((previous, color)) = cache.as_ref() {
            if *previous == key {
                return *color;
            }
        }
        // Windows also uses extensionless cache files containing JPEG bytes.
        let sample = (|| {
            let mut reader = image::ImageReader::open(&key.0)
                .ok()?
                .with_guessed_format()
                .ok()?;
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(256 * 1024 * 1024);
            reader.limits(limits);
            let image = reader.decode().ok()?.thumbnail(80, 80).into_rgba8();
            super::representative_color(image.pixels().map(|pixel| pixel.0))
        })();
        *cache = Some((key, sample));
        sample
    }

    pub fn color() -> Rgb {
        wallpaper_path().and_then(image_color).unwrap_or_else(|| {
            const COLOR_BACKGROUND: i32 = 1;
            let color = unsafe { GetSysColor(COLOR_BACKGROUND) };
            [color as u8, (color >> 8) as u8, (color >> 16) as u8]
        })
    }
}

#[cfg(any(target_os = "windows", test))]
fn representative_color(pixels: impl Iterator<Item = [u8; 4]>) -> Option<[u8; 3]> {
    const SECTORS: usize = 24;
    #[derive(Clone, Copy, Default)]
    struct Sample {
        count: u32,
        rgb: [u32; 3],
        weight: u32,
    }

    let mut sectors = [Sample::default(); SECTORS];
    let mut all = Sample::default();
    for [r, g, b, alpha] in pixels {
        if alpha < 128 {
            continue;
        }
        all.count += 1;
        let rgb = [u32::from(r), u32::from(g), u32::from(b)];
        for (total, channel) in all.rgb.iter_mut().zip(rgb) {
            *total += channel;
        }
        let max = r.max(g).max(b);
        let chroma = max - r.min(g).min(b);
        if chroma < 18 {
            continue;
        }
        let hue = if max == r {
            f32::from(g) - f32::from(b)
        } else if max == g {
            f32::from(b) - f32::from(r) + 2.0 * f32::from(chroma)
        } else {
            f32::from(r) - f32::from(g) + 4.0 * f32::from(chroma)
        } / f32::from(chroma);
        let index = (hue.rem_euclid(6.0) * (SECTORS as f32 / 6.0)) as usize % SECTORS;
        let sector = &mut sectors[index];
        // Cap the weight so small neon details cannot overpower larger,
        // softer regions of the same or a neighboring hue.
        let weight = u32::from(chroma.min(96));
        sector.count += 1;
        sector.weight += weight;
        for (total, channel) in sector.rgb.iter_mut().zip(rgb) {
            *total += channel * weight;
        }
    }
    if all.count == 0 {
        return None;
    }

    let mut dominant = Sample::default();
    for index in 0..SECTORS {
        let mut nearby = Sample::default();
        // Blend neighboring hue bins, including both sides of red's wrap.
        for offset in [SECTORS - 1, 0, 1] {
            let sector = sectors[(index + offset) % SECTORS];
            nearby.count += sector.count;
            nearby.weight += sector.weight;
            for (total, channel) in nearby.rgb.iter_mut().zip(sector.rgb) {
                *total += channel;
            }
        }
        if nearby.count * 8 >= all.count && nearby.weight > dominant.weight {
            dominant = nearby;
        }
    }
    if dominant.weight > 0 {
        Some(dominant.rgb.map(|sum| (sum / dominant.weight) as u8))
    } else {
        Some(all.rgb.map(|sum| (sum / all.count) as u8))
    }
}

pub fn get_wallpaper_color() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let [r, g, b] = windows::color();
        Ok(format!("#{r:02x}{g:02x}{b:02x}"))
    }
    #[cfg(not(target_os = "windows"))]
    Err("wallpaper colors are only supported on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::representative_color;

    #[test]
    fn selects_a_wallpaper_hue_without_averaging_complementary_colors() {
        let blue = [42, 102, 168, 255];
        let pixels = [blue; 60].into_iter().chain([[168, 104, 42, 255]; 40]);
        assert_eq!(representative_color(pixels), Some([42, 102, 168]));
    }

    #[test]
    fn ignores_small_neon_details_and_transparent_pixels() {
        let pixels = [[128, 128, 128, 255]; 99]
            .into_iter()
            .chain([[255, 0, 130, 255]])
            .chain([[255, 0, 130, 0]; 100]);
        assert_eq!(representative_color(pixels), Some([129, 126, 128]));
    }
}
