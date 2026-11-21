//! Windows shell icon and thumbnail extraction.

#[cfg(target_os = "windows")]
static SHELL_ICONS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Return the real Shell artwork at the tile's physical size.
#[cfg(target_os = "windows")]
pub fn get_file_icon_base64(path: &str, size_px: u32) -> Result<String, String> {
    let size_px = size_px.clamp(16, 256);
    // Thumbnails suit standalone media and Explorer's folder previews.
    // Application shortcuts and documents use their registered shell icon.
    let file = std::path::Path::new(path);
    let media = file
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "bmp" | "gif" | "webp" | "mp4" | "mkv" | "mov" | "avi"
            )
        });
    let (pixels, size) = {
        // Concurrent first access to the shell image lists can return the
        // smaller legacy icon. Serialize extraction, then encode in parallel.
        let _shell = SHELL_ICONS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let thumbnail = if media || file.is_dir() {
            icon_ffi::extract_thumbnail_rgba(path, size_px as i32)
        } else {
            None
        };
        thumbnail.map_or_else(|| icon_ffi::extract_icon_rgba(path), Ok)?
    };

    use image::{ImageBuffer, ImageEncoder, Rgba};
    let mut img = ImageBuffer::<Rgba<u8>, _>::from_raw(size, size, pixels)
        .ok_or("failed to create image buffer")?;

    // Filter premultiplied color at the final physical size to avoid a dark
    // outline on antialiased edges and a second resize in the WebView.
    let size = if size > size_px {
        for p in img.pixels_mut() {
            let a = p[3] as u32;
            for c in 0..3 {
                p[c] = ((p[c] as u32 * a + 127) / 255) as u8;
            }
        }
        img = image::imageops::resize(
            &img,
            size_px,
            size_px,
            image::imageops::FilterType::Lanczos3,
        );
        for p in img.pixels_mut() {
            let a = p[3] as u32;
            if a > 0 {
                for c in 0..3 {
                    p[c] = ((p[c] as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        size_px
    } else {
        size
    };

    let mut png_bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png_bytes)
        .write_image(&img, size, size, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;

    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png_bytes);
    Ok(format!("data:image/png;base64,{}", b64))
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
mod icon_ffi {
    use crate::win32::{ComGuard, Guid};
    use std::ffi::c_void;
    use windows::Win32::{
        Graphics::Gdi::{DeleteObject as DeleteGdiObject, GetObjectW, BITMAP},
        UI::WindowsAndMessaging::{GetIconInfo, HICON, ICONINFO},
    };

    #[repr(C)]
    struct ShFileInfo {
        hIcon: isize,
        iIcon: i32,
        dwAttributes: u32,
        szDisplayName: [u16; 260],
        szTypeName: [u16; 80],
    }
    #[repr(C)]
    struct BitmapInfoHeader {
        biSize: u32,
        biWidth: i32,
        biHeight: i32,
        biPlanes: u16,
        biBitCount: u16,
        biCompression: u32,
        biSizeImage: u32,
        biXPelsPerMeter: i32,
        biYPelsPerMeter: i32,
        biClrUsed: u32,
        biClrImportant: u32,
    }
    #[repr(C)]
    struct BitmapInfo {
        bmiHeader: BitmapInfoHeader,
    }

    // IID_IImageList {46EB5926-582E-4017-9FDF-E8998DAA0950}
    const IID_IMAGE_LIST: Guid = Guid {
        d1: 0x46EB5926,
        d2: 0x582E,
        d3: 0x4017,
        d4: [0x9F, 0xDF, 0xE8, 0x99, 0x8D, 0xAA, 0x09, 0x50],
    };
    // IID_IShellItemImageFactory {BCC18B79-BA16-442F-80C4-8A59C30C463B}
    const IID_SHELL_ITEM_IMAGE_FACTORY: Guid = Guid {
        d1: 0xBCC18B79,
        d2: 0xBA16,
        d3: 0x442F,
        d4: [0x80, 0xC4, 0x8A, 0x59, 0xC3, 0x0C, 0x46, 0x3B],
    };

    const SHGFI_ICON: u32 = 0x100;
    const SHGFI_LARGEICON: u32 = 0x0;
    const SHGFI_SYSICONINDEX: u32 = 0x4000;
    const SHGFI_ADDOVERLAYS: u32 = 0x20;
    const SHGFI_OVERLAYINDEX: u32 = 0x40;
    const SHGFI_USEFILEATTRIBUTES: u32 = 0x10;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const SHIL_EXTRALARGE: i32 = 2; // 48x48
    const SHIL_JUMBO: i32 = 4; // 256x256
    const ILD_TRANSPARENT: u32 = 0x1;
    const DIB_RGB_COLORS: u32 = 0;
    const BI_RGB: u32 = 0;
    const DI_NORMAL: u32 = 3;

    extern "system" {
        fn SHGetFileInfoW(
            path: *const u16,
            attr: u32,
            info: *mut ShFileInfo,
            cb: u32,
            flags: u32,
        ) -> usize;
        fn SHGetImageList(iImageList: i32, riid: *const Guid, ppv: *mut *mut c_void) -> i32;
        fn CreateCompatibleDC(h: isize) -> isize;
        fn CreateDIBSection(
            hdc: isize,
            pbmi: *const BitmapInfo,
            usage: u32,
            ppvBits: *mut *mut c_void,
            hSection: isize,
            offset: u32,
        ) -> isize;
        fn SelectObject(h: isize, o: isize) -> isize;
        fn DeleteDC(h: isize) -> i32;
        fn DeleteObject(o: isize) -> i32;
        fn DestroyIcon(i: isize) -> i32;
        fn DrawIconEx(
            dc: isize,
            x: i32,
            y: i32,
            hi: isize,
            cx: i32,
            cy: i32,
            step: u32,
            brush: isize,
            flags: u32,
        ) -> i32;
    }

    /// Get an HICON of the given shell image-list size (SHIL_*) for a
    /// system image-list index, via the IImageList COM interface.
    fn imagelist_icon(which: i32, index: i32, overlay: u32) -> Option<isize> {
        // IImageList vtable: 0-2 IUnknown (QI/AddRef/Release), 3 Add,
        // 4 ReplaceIcon, 5 SetOverlayImage, 6 Replace, 7 AddMasked,
        // 8 Draw, 9 Remove, 10 GetIcon - stable public ABI since Vista.
        type GetIconFn = unsafe extern "system" fn(*mut c_void, i32, u32, *mut isize) -> i32;
        type ReleaseFn = unsafe extern "system" fn(*mut c_void) -> u32;
        unsafe {
            let mut list: *mut c_void = std::ptr::null_mut();
            if SHGetImageList(which, &IID_IMAGE_LIST, &mut list) != 0 || list.is_null() {
                return None;
            }
            let vtbl = *(list as *mut *const usize);
            let get_icon: GetIconFn = std::mem::transmute(*vtbl.add(10));
            let release: ReleaseFn = std::mem::transmute(*vtbl.add(2));
            let mut hicon: isize = 0;
            let hr = get_icon(list, index, ILD_TRANSPARENT | (overlay << 8), &mut hicon);
            release(list);
            (hr == 0 && hicon != 0).then_some(hicon)
        }
    }

    /// Read the actual icon dimensions (image lists scale at high DPI).
    fn icon_size(hicon: isize) -> Result<i32, String> {
        let mut info = ICONINFO::default();
        unsafe { GetIconInfo(HICON(hicon as *mut c_void), &mut info) }
            .map_err(|error| error.to_string())?;
        let monochrome = info.hbmColor.is_invalid();
        let source = if monochrome {
            info.hbmMask
        } else {
            info.hbmColor
        };
        let mut bitmap = BITMAP::default();
        let bytes = unsafe {
            let bytes = GetObjectW(
                source.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some((&mut bitmap as *mut BITMAP).cast()),
            );
            let _ = DeleteGdiObject(info.hbmMask.into());
            if !monochrome {
                let _ = DeleteGdiObject(info.hbmColor.into());
            }
            bytes
        };
        let height = if monochrome {
            bitmap.bmHeight / 2
        } else {
            bitmap.bmHeight
        };
        let size = bitmap.bmWidth.max(height);
        if bytes == 0 || !(1..=1024).contains(&size) {
            return Err("invalid icon bitmap size".into());
        }
        Ok(size)
    }

    /// Render the HICON at its source size into a top-down RGBA buffer. Consumes the icon.
    fn render_icon_rgba(hicon: isize) -> Result<(Vec<u8>, u32), String> {
        struct Cleanup {
            hdc: isize,
            hbitmap: isize,
            old_obj: isize,
            hicon: isize,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                unsafe {
                    if self.old_obj != 0 {
                        SelectObject(self.hdc, self.old_obj);
                    }
                    if self.hbitmap != 0 {
                        DeleteObject(self.hbitmap);
                    }
                    if self.hdc != 0 {
                        DeleteDC(self.hdc);
                    }
                    DestroyIcon(self.hicon);
                }
            }
        }

        let hdc = unsafe { CreateCompatibleDC(0) };
        let mut cleanup = Cleanup {
            hdc,
            hbitmap: 0,
            old_obj: 0,
            hicon,
        };
        let size = icon_size(hicon)?;
        if hdc == 0 {
            return Err("CreateCompatibleDC failed".into());
        }

        let bmi = BitmapInfo {
            bmiHeader: BitmapInfoHeader {
                biSize: std::mem::size_of::<BitmapInfoHeader>() as u32,
                biWidth: size,
                biHeight: -size, // negative = top-down DIB
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
        };

        let mut p_bits: *mut c_void = std::ptr::null_mut();
        let hbitmap = unsafe { CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut p_bits, 0, 0) };
        cleanup.hbitmap = hbitmap;
        if hbitmap == 0 || p_bits.is_null() {
            return Err("CreateDIBSection failed".into());
        }
        cleanup.old_obj = unsafe { SelectObject(hdc, hbitmap) };

        let buffer_size = (size * size * 4) as usize;
        unsafe { std::ptr::write_bytes(p_bits.cast::<u8>(), 0, buffer_size) };
        if unsafe { DrawIconEx(hdc, 0, 0, hicon, size, size, 0, 0, DI_NORMAL) } == 0 {
            return Err("DrawIconEx failed".into());
        }
        let _ = unsafe { windows::Win32::Graphics::Gdi::GdiFlush() };

        let mut pixels = vec![0u8; buffer_size];
        unsafe {
            std::ptr::copy_nonoverlapping(p_bits as *const u8, pixels.as_mut_ptr(), buffer_size);
            std::ptr::write_bytes(p_bits.cast::<u8>(), 255, buffer_size);
        }
        if unsafe { DrawIconEx(hdc, 0, 0, hicon, size, size, 0, 0, DI_NORMAL) } == 0 {
            return Err("DrawIconEx failed on the alpha reference".into());
        }
        let _ = unsafe { windows::Win32::Graphics::Gdi::GdiFlush() };
        let white = unsafe { std::slice::from_raw_parts(p_bits.cast::<u8>(), buffer_size) };
        // DrawIconEx may leave the alpha channel unset on mask-based icons.
        // Compositing onto black and white recovers both true black details
        // and antialiased edges regardless of the original HICON format.
        for (black, white) in pixels.chunks_exact_mut(4).zip(white.chunks_exact(4)) {
            let transparent = (0..3)
                .map(|i| white[i].saturating_sub(black[i]))
                .max()
                .unwrap_or(255);
            let alpha = 255 - transparent;
            for value in &mut black[..3] {
                *value = if alpha == 0 {
                    0
                } else {
                    ((u32::from(*value) * 255 + u32::from(alpha) / 2) / u32::from(alpha)).min(255)
                        as u8
                };
            }
            black.swap(0, 2);
            black[3] = alpha;
        }
        Ok((pixels, size as u32))
    }

    /// Jumbo (256) quirk: icons without 256px art get stamped as a small
    /// image in the top-left corner of the canvas. Detect via the opaque
    /// bounding box; such icons fall back to SHIL_EXTRALARGE.
    fn is_corner_stamped(pixels: &[u8], size: u32) -> bool {
        let mut max_x = 0u32;
        let mut max_y = 0u32;
        let mut any = false;
        for (i, chunk) in pixels.chunks_exact(4).enumerate() {
            let x = (i as u32) % size;
            let y = (i as u32) / size;
            // A shortcut arrow at the bottom-left must not make a small
            // corner stamp look like full-size primary artwork.
            if chunk[3] > 8 && !(x < size / 3 && y > size * 2 / 3) {
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                any = true;
            }
        }
        !any || (max_x < size / 2 && max_y < size / 2)
    }

    /// Shell thumbnail (images/videos/anything with a thumbnail provider) as
    /// (rgba_pixels, size). None when the file type has no thumbnail - the
    /// caller falls back to the icon pipeline. SIIGBF_THUMBNAILONLY makes
    /// icon-only files fail instead of returning a blurry scaled icon.
    pub fn extract_thumbnail_rgba(path: &str, size: i32) -> Option<(Vec<u8>, u32)> {
        const SIIGBF_BIGGERSIZEOK: u32 = 0x1;
        const SIIGBF_THUMBNAILONLY: u32 = 0x8;

        #[repr(C)]
        struct SizeStruct {
            cx: i32,
            cy: i32,
        }
        #[repr(C)]
        struct Bitmap {
            bmType: i32,
            bmWidth: i32,
            bmHeight: i32,
            bmWidthBytes: i32,
            bmPlanes: u16,
            bmBitsPixel: u16,
            bmBits: *mut c_void,
        }

        extern "system" {
            fn SHCreateItemFromParsingName(
                path: *const u16,
                pbc: *mut c_void,
                riid: *const Guid,
                ppv: *mut *mut c_void,
            ) -> i32;
            #[link_name = "GetObjectW"]
            fn get_bitmap_object(h: isize, cb: i32, pv: *mut c_void) -> i32;
            fn GetDIBits(
                hdc: isize,
                hbm: isize,
                start: u32,
                lines: u32,
                bits: *mut c_void,
                bmi: *mut BitmapInfo,
                usage: u32,
            ) -> i32;
        }

        let _com = ComGuard::init();
        let wide_path = crate::win32::wide(path);
        unsafe {
            let mut item: *mut c_void = std::ptr::null_mut();
            if SHCreateItemFromParsingName(
                wide_path.as_ptr(),
                std::ptr::null_mut(),
                &IID_SHELL_ITEM_IMAGE_FACTORY,
                &mut item,
            ) != 0
                || item.is_null()
            {
                return None;
            }
            let factory = crate::win32::ComPtr(item);

            // IShellItemImageFactory vtable: 0-2 IUnknown, 3 GetImage
            type GetImageFn =
                unsafe extern "system" fn(*mut c_void, SizeStruct, u32, *mut isize) -> i32;
            let get_image: GetImageFn = std::mem::transmute(*factory.vtbl().add(3));
            let mut hbm: isize = 0;
            if get_image(
                factory.0,
                SizeStruct { cx: size, cy: size },
                SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK,
                &mut hbm,
            ) != 0
                || hbm == 0
            {
                return None;
            }
            struct BitmapFree(isize);
            impl Drop for BitmapFree {
                fn drop(&mut self) {
                    unsafe { DeleteObject(self.0) };
                }
            }
            let _hbm_free = BitmapFree(hbm);

            let mut bm = std::mem::zeroed::<Bitmap>();
            if get_bitmap_object(
                hbm,
                std::mem::size_of::<Bitmap>() as i32,
                &mut bm as *mut _ as _,
            ) == 0
                || bm.bmWidth <= 0
                || bm.bmHeight <= 0
            {
                return None;
            }
            // Thumbnails are not necessarily square - letterbox onto a square
            // canvas would distort; instead just read the pixels and let the
            // frontend's object-contain do the fitting. Encode as a square by
            // using the LARGER edge; the canvas stays transparent around it.
            let (w, h) = (bm.bmWidth, bm.bmHeight);

            let hdc = CreateCompatibleDC(0);
            if hdc == 0 {
                return None;
            }
            struct DcFree(isize);
            impl Drop for DcFree {
                fn drop(&mut self) {
                    unsafe { DeleteDC(self.0) };
                }
            }
            let _dc_free = DcFree(hdc);

            let mut bmi = BitmapInfo {
                bmiHeader: BitmapInfoHeader {
                    biSize: std::mem::size_of::<BitmapInfoHeader>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
            };
            let mut bgra = vec![0u8; (w * h * 4) as usize];
            if GetDIBits(
                hdc,
                hbm,
                0,
                h as u32,
                bgra.as_mut_ptr() as _,
                &mut bmi,
                DIB_RGB_COLORS,
            ) == 0
            {
                return None;
            }

            // BGRA -> RGBA on a square transparent canvas (edge = max(w, h))
            let edge = w.max(h) as u32;
            let (off_x, off_y) = (
                ((edge as i32 - w) / 2) as u32,
                ((edge as i32 - h) / 2) as u32,
            );
            let mut pixels = vec![0u8; (edge * edge * 4) as usize];
            for row in 0..h as u32 {
                for col in 0..w as u32 {
                    let src = ((row * w as u32 + col) * 4) as usize;
                    let dst = (((row + off_y) * edge + (col + off_x)) * 4) as usize;
                    pixels[dst] = bgra[src + 2];
                    pixels[dst + 1] = bgra[src + 1];
                    pixels[dst + 2] = bgra[src];
                    pixels[dst + 3] = bgra[src + 3];
                }
            }
            // Providers that ignore the alpha channel leave it all-zero ->
            // treat as fully opaque (same fix as legacy mask icons)
            if pixels.chunks_exact(4).all(|c| c[3] == 0) {
                for row in 0..h as u32 {
                    for col in 0..w as u32 {
                        let dst = (((row + off_y) * edge + (col + off_x)) * 4) as usize;
                        pixels[dst + 3] = 255;
                    }
                }
            }
            Some((pixels, edge))
        }
    }

    /// Extract the best available icon as (rgba_pixels, size).
    pub fn extract_icon_rgba(path: &str) -> Result<(Vec<u8>, u32), String> {
        let _com = ComGuard::init();
        let wide_path = crate::win32::wide(path);
        let mut shfi = ShFileInfo {
            hIcon: 0,
            iIcon: 0,
            dwAttributes: 0,
            szDisplayName: [0; 260],
            szTypeName: [0; 80],
        };

        // 1. Resolve the system image-list index (accesses the real file)
        let ok = unsafe {
            SHGetFileInfoW(
                wide_path.as_ptr(),
                0,
                &mut shfi,
                std::mem::size_of::<ShFileInfo>() as u32,
                SHGFI_SYSICONINDEX | SHGFI_ICON | SHGFI_ADDOVERLAYS | SHGFI_OVERLAYINDEX,
            )
        };
        if ok != 0 {
            let packed = shfi.iIcon as u32;
            let index = (packed & 0x00ff_ffff) as i32;
            let overlay = packed >> 24;
            if let Some(hicon) = imagelist_icon(SHIL_JUMBO, index, overlay) {
                if let Ok((pixels, size)) = render_icon_rgba(hicon) {
                    if !is_corner_stamped(&pixels, size) {
                        if shfi.hIcon != 0 {
                            unsafe {
                                DestroyIcon(shfi.hIcon);
                            }
                        }
                        return Ok((pixels, size));
                    }
                }
            }
            if let Some(hicon) = imagelist_icon(SHIL_EXTRALARGE, index, overlay) {
                if let Ok(icon) = render_icon_rgba(hicon) {
                    if shfi.hIcon != 0 {
                        unsafe {
                            DestroyIcon(shfi.hIcon);
                        }
                    }
                    return Ok(icon);
                }
            }
            if shfi.hIcon != 0 {
                return render_icon_rgba(shfi.hIcon);
            }
        }

        // 2. Legacy fallback: per-extension generic icon (also works when the
        //    file itself no longer exists)
        let result = unsafe {
            SHGetFileInfoW(
                wide_path.as_ptr(),
                FILE_ATTRIBUTE_NORMAL,
                &mut shfi,
                std::mem::size_of::<ShFileInfo>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
            )
        };
        if result == 0 || shfi.hIcon == 0 {
            return Err("SHGetFileInfoW failed".into());
        }
        render_icon_rgba(shfi.hIcon)
    }
}

/// Stub for non-Windows platforms.
#[cfg(not(target_os = "windows"))]
pub fn get_file_icon_base64(_path: &str, _size_px: u32) -> Result<String, String> {
    Err("icon extraction not supported on this platform".into())
}
