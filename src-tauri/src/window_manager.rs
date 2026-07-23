//! DeskChan window manager.
//!
//! Three mechanisms ensure the window survives Win+D (Show Desktop):
//! 1. AppBar registration — SHAppBarMessage(ABM_NEW/QUERYPOS/SETPOS) grants
//!    system-level immunity from Win+D's window enumeration (same as taskbar).
//! 2. WndProc replacement — intercepts WM_SHOWWINDOW, SC_MINIMIZE,
//!    WM_WINDOWPOSCHANGING, and WM_SIZE to block hide/minimize/coordinate exile.
//! 3. Z-order counter-attack — polling thread detects when desktop WorkerW
//!    is brought to foreground (Win+D side effect) and pushes it behind us.
//!
//! Cursor polling (33ms) toggles WS_EX_TRANSPARENT for click-through.
//!
//! Desktop icon management: hides the native SysListView32 on startup,
//! shows it on quit. Files never leave the desktop — we just hide the icons
//! and render our own overlay.

use crate::config::CellRect;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

// ── Shared state ───────────────────────────────────────────────────────────

pub struct DeskState {
    pub regions: Mutex<Vec<CellRect>>,
    pub running: AtomicBool,
    pub ignoring: AtomicBool,
    /// Set by JS when pointer-event drag is active — polling must NOT enable click-through.
    pub dragging: AtomicBool,
}

impl DeskState {
    pub fn new() -> Self {
        Self {
            regions: Mutex::new(Vec::new()),
            running: AtomicBool::new(true),
            ignoring: AtomicBool::new(false),
            dragging: AtomicBool::new(false),
        }
    }
}

// ── Win32 constants ────────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod constants {
    // Extended window styles
    pub const WS_EX_TOOLWINDOW: i32 = 0x80;
    pub const WS_EX_NOACTIVATE: i32 = 0x08000000;

    // Window styles
    pub const WS_MINIMIZEBOX: i32 = 0x00020000;
    pub const WS_MAXIMIZEBOX: i32 = 0x00010000;

    // GWL indices
    pub const GWL_EXSTYLE: i32 = -20;
    pub const GWL_STYLE: i32 = -16;
    pub const GWLP_WNDPROC: i32 = -4;

    // Window messages
    pub const WM_SHOWWINDOW: u32 = 0x0018;
    pub const WM_WINDOWPOSCHANGING: u32 = 0x0046;
    pub const WM_SYSCOMMAND: u32 = 0x0112;
    pub const WM_SIZE: u32 = 0x0005;

    // Message parameters
    pub const SC_MINIMIZE: usize = 0xF020;
    pub const SIZE_MINIMIZED: usize = 1;
    pub const SWP_HIDEWINDOW: u32 = 0x0080;
    pub const SWP_NOMOVE: u32 = 0x0002;
    pub const SWP_NOSIZE: u32 = 0x0001;
    pub const SWP_NOACTIVATE: u32 = 0x0010;

    // SetWindowPos flags composition
    pub const SWP_NOSIZE_NOMOVE_NOACTIVATE: u32 = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;

    // AppBar
    pub const ABM_NEW: u32 = 0;
    pub const ABM_QUERYPOS: u32 = 2;
    pub const ABM_SETPOS: u32 = 3;
    pub const ABE_TOP: u32 = 1;

    // System
    pub const SPI_GETWORKAREA: u32 = 48;

    // Coordinate exile threshold (Win+D sends windows to -32000)
    pub const COORDINATE_EXILE_THRESHOLD: i32 = -10000;
}

// ── Init: AppBar + styles + WndProc replacement ────────────────────────────

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
pub fn init(window: &WebviewWindow) {
    use constants::*;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let hwnd = match window.window_handle().ok().map(|r| match r.as_raw() {
        RawWindowHandle::Win32(w) => w.hwnd.get() as isize,
        _ => 0isize,
    }) {
        Some(x) => x,
        None => return,
    };

    // FFI declarations
    extern "system" {
        fn GetWindowLongW(h: isize, i: i32) -> i32;
        fn SetWindowLongW(h: isize, i: i32, v: i32) -> i32;
        fn GetWindowLongPtrW(h: isize, i: i32) -> isize;
        fn SetWindowLongPtrW(h: isize, i: i32, v: isize) -> isize;
        fn SHAppBarMessage(dw: u32, p: *mut AppBarData) -> usize;
    }

    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct AppBarData {
        cbSize: u32,
        hWnd: isize,
        uCallbackMessage: u32,
        uEdge: u32,
        rc: Rect,
        lParam: isize,
    }

    unsafe {
        // ── Window styles ────────────────────────────────────────────
        // Tool window (no taskbar entry) + no activation (no focus stealing)
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);

        // Strip minimize/maximize boxes — window cannot be minimized
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        SetWindowLongW(hwnd, GWL_STYLE, style & !WS_MINIMIZEBOX & !WS_MAXIMIZEBOX);

        // ── AppBar registration ──────────────────────────────────────
        // Register as Application Desktop Toolbar. Windows taskbar uses
        // the same mechanism. Win+D unconditionally exempts AppBars.
        // Must call NEW → QUERYPOS → SETPOS for valid registration.
        let mut abd = AppBarData {
            cbSize: std::mem::size_of::<AppBarData>() as u32,
            hWnd: hwnd,
            uCallbackMessage: 0x0401, // WM_USER + 1 — must be non-zero
            uEdge: ABE_TOP,
            rc: Rect { left: 0, top: 0, right: 0, bottom: 0 },
            lParam: 0,
        };
        SHAppBarMessage(ABM_NEW, &mut abd);
        abd.rc = Rect { left: 0, top: 0, right: 1920, bottom: 0 };
        SHAppBarMessage(ABM_QUERYPOS, &mut abd);
        SHAppBarMessage(ABM_SETPOS, &mut abd);

        // ── WndProc replacement ──────────────────────────────────────
        // Replace window procedure to intercept hide/minimize messages.
        // Uses CallWindowProcW for safe chaining (no transmute needed).
        let orig = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        ORIGINAL_WNDPROC.store(orig, Ordering::Relaxed);
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wndproc as *const () as isize);
    }

    // Start interactive — cursor polling will toggle click-through later
    let _ = window.set_ignore_cursor_events(false);

    // Hide native desktop icons — our overlay replaces them entirely
    hide_desktop_icons();
}

/// Hide the desktop's SysListView32 so our overlay is the only visible desktop.
#[cfg(target_os = "windows")]
fn hide_desktop_icons() {
    extern "system" {
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    }
    if let Some(list_view) = find_desktop_listview() {
        const SW_HIDE: i32 = 0;
        unsafe { ShowWindow(list_view, SW_HIDE) };
    }
}

/// Show the desktop's SysListView32 — restore native desktop icons.
#[cfg(target_os = "windows")]
pub fn show_desktop_icons() {
    extern "system" {
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    }
    if let Some(list_view) = find_desktop_listview() {
        const SW_SHOW: i32 = 5;
        unsafe { ShowWindow(list_view, SW_SHOW) };
    }
}

/// Find the SysListView32 that renders desktop icons.
/// Searches both Progman → SHELLDLL_DefView → SysListView32 (classic)
/// and WorkerW → SHELLDLL_DefView → SysListView32 (modern Windows 10/11).
#[cfg(target_os = "windows")]
fn find_desktop_listview() -> Option<isize> {
    extern "system" {
        fn FindWindowW(class: *const u16, name: *const u16) -> isize;
        fn FindWindowExW(parent: isize, child: isize, class: *const u16, name: *const u16) -> isize;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let shelldll = wide("SHELLDLL_DefView");
    let syslist = wide("SysListView32");

    unsafe {
        // Try Progman first (pre-Win10)
        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman != 0 {
            let def = FindWindowExW(progman, 0, shelldll.as_ptr(), std::ptr::null());
            if def != 0 {
                let lv = FindWindowExW(def, 0, syslist.as_ptr(), std::ptr::null());
                if lv != 0 {
                    return Some(lv);
                }
            }
        }

        // Try WorkerW (Win10+). There may be multiple WorkerW windows;
        // the correct one has a SHELLDLL_DefView child.
        let workerw = wide("WorkerW");
        let mut hwnd = FindWindowW(workerw.as_ptr(), std::ptr::null());
        while hwnd != 0 {
            let def = FindWindowExW(hwnd, 0, shelldll.as_ptr(), std::ptr::null());
            if def != 0 {
                let lv = FindWindowExW(def, 0, syslist.as_ptr(), std::ptr::null());
                if lv != 0 {
                    return Some(lv);
                }
            }
            hwnd = FindWindowExW(0, hwnd, workerw.as_ptr(), std::ptr::null());
        }
    }
    None
}

#[cfg(target_os = "windows")]
static ORIGINAL_WNDPROC: std::sync::atomic::AtomicIsize =
    std::sync::atomic::AtomicIsize::new(0);

/// Custom window procedure. Blocks all attempts to hide, minimize, or
/// coordinate-exile the window (Win+D's three attack vectors).
#[cfg(target_os = "windows")]
unsafe extern "system" fn wndproc(
    hwnd: isize,
    msg: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    use constants::*;

    match msg {
        // Block hide
        WM_SHOWWINDOW if wparam == 0 => return 0,

        // Block minimize via system menu
        WM_SYSCOMMAND if (wparam & 0xFFF0) == SC_MINIMIZE => return 0,

        // Block SIZE_MINIMIZED → prevents WebView2 from stopping render
        WM_SIZE if wparam == SIZE_MINIMIZED => return 0,

        // Intercept window position changes
        WM_WINDOWPOSCHANGING => {
            #[repr(C)]
            struct WindowPos {
                hwnd: isize,
                after: isize,
                x: i32,
                y: i32,
                cx: i32,
                cy: i32,
                flags: u32,
            }
            let wp = &mut *(lparam as *mut WindowPos);

            // Strip SWP_HIDEWINDOW — prevent hiding
            wp.flags &= !SWP_HIDEWINDOW;

            // Block coordinate exile: Win+D sends windows to (-32000, -32000)
            if wp.x < COORDINATE_EXILE_THRESHOLD || wp.y < COORDINATE_EXILE_THRESHOLD {
                wp.flags |= SWP_NOMOVE;
            }
        }
        _ => {}
    }

    extern "system" {
        fn CallWindowProcW(p: isize, h: isize, m: u32, w: usize, l: isize) -> isize;
    }
    CallWindowProcW(ORIGINAL_WNDPROC.load(Ordering::Relaxed), hwnd, msg, wparam, lparam)
}

// ── Window sizing ──────────────────────────────────────────────────────────

/// Position and size the window to cover the primary monitor's work area
/// (desktop area excluding taskbar).
pub fn fit_to_work_area<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (x, y, w, h) = get_work_area(app);
    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
    let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
}

/// Returns the primary monitor's work area as (x, y, width, height) in physical pixels.
#[allow(non_snake_case)]
fn get_work_area<R: Runtime>(_app: &tauri::AppHandle<R>) -> (f64, f64, f64, f64) {
    #[cfg(target_os = "windows")]
    {
        use constants::SPI_GETWORKAREA;
        #[repr(C)]
        struct WinRect {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }
        extern "system" {
            fn SystemParametersInfoW(
                action: u32,
                param: u32,
                pv: *mut std::ffi::c_void,
                ini: u32,
            ) -> i32;
        }
        let mut rect = WinRect { left: 0, top: 0, right: 0, bottom: 0 };
        if unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut rect as *mut _ as _, 0) } != 0
        {
            return (
                rect.left as f64,
                rect.top as f64,
                (rect.right - rect.left) as f64,
                (rect.bottom - rect.top) as f64,
            );
        }
    }
    (0.0, 0.0, 1920.0, 1080.0) // fallback
}

// ── Background threads ─────────────────────────────────────────────────────

/// Start both the cursor-polling thread (click-through toggle) and the
/// Z-order counter-attack (Win+D resistance).
pub fn start_background_threads(app: tauri::AppHandle, state: Arc<DeskState>) {
    let app2 = app.clone();
    let state2 = state.clone();
    std::thread::spawn(move || polling_loop(app2, state2));
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
fn polling_loop(app: tauri::AppHandle, state: Arc<DeskState>) {
    use constants::SWP_NOSIZE_NOMOVE_NOACTIVATE;

    // Internal FFI declarations
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    extern "system" {
        fn GetCursorPos(p: *mut Point) -> i32;
        fn GetForegroundWindow() -> isize;
        fn GetClassNameW(h: isize, b: *mut u16, m: i32) -> i32;
        fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, f: u32) -> i32;
    }

    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let poll_interval = std::time::Duration::from_millis(33); // ~30 fps

    while state.running.load(Ordering::Relaxed) {
        std::thread::sleep(poll_interval);

        let Some(window) = app.get_webview_window("main") else {
            continue;
        };
        let our_hwnd = match window.window_handle().unwrap().as_raw() {
            RawWindowHandle::Win32(wh) => wh.hwnd.get() as isize,
            _ => 0,
        };

        // ── Z-order counter-attack ──────────────────────────────────────
        // Win+D brings the desktop wallpaper (WorkerW/Progman) to the top
        // of the Z-order, physically covering our window. Detect when the
        // desktop is the foreground window and push it behind us.
        let fg = unsafe { GetForegroundWindow() };
        if fg != 0 && fg != our_hwnd {
            let mut class_name = [0u16; 64];
            let len = unsafe { GetClassNameW(fg, class_name.as_mut_ptr(), 64) };
            if len > 0 {
                let cls = String::from_utf16_lossy(&class_name[..len as usize]);
                if cls.starts_with("WorkerW") || cls.starts_with("Progman") {
                    unsafe {
                        SetWindowPos(fg, our_hwnd, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE);
                    }
                }
            }
        }

        // ── Cursor polling (click-through toggle) ───────────────────────
        let mut pt = Point { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut pt) };

        let Ok(window_pos) = window.outer_position() else {
            continue;
        };
        let Ok(scale_factor) = window.scale_factor() else {
            continue;
        };

        // Convert screen physical pixels → window-relative logical pixels
        let logical_x = (pt.x - window_pos.x as i32) as f64 / scale_factor;
        let logical_y = (pt.y - window_pos.y as i32) as f64 / scale_factor;

        let regions = state.regions.lock().unwrap();
        if regions.is_empty() {
            continue;
        }

        let over_cell = regions.iter().any(|r| {
            logical_x >= r.x
                && logical_x <= r.x + r.width
                && logical_y >= r.y
                && logical_y <= r.y + r.height
        });

        let should_ignore = !over_cell && !state.dragging.load(Ordering::Relaxed);
        if should_ignore != state.ignoring.load(Ordering::Relaxed) {
            let _ = window.set_ignore_cursor_events(should_ignore);
            state.ignoring.store(should_ignore, Ordering::Relaxed);
        }
    }
}

// Stub for non-Windows platforms
#[cfg(not(target_os = "windows"))]
fn polling_loop(_app: tauri::AppHandle, _state: Arc<DeskState>) {}

// ── File icon extraction ──────────────────────────────────────────────────

/// Extract the system file icon via SHGetFileInfoW and return as a
/// base64-encoded PNG data URL.
///
/// Uses CreateDIBSection for reliable 32-bit BGRA pixel access and handles
/// legacy/system icon Alpha channel transparency issues.
#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
pub fn get_file_icon_base64(path: &str) -> Result<String, String> {
    use std::ffi::c_void;

    // ── FFI ────────────────────────────────────────────────────────────
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

    extern "system" {
        fn SHGetFileInfoW(
            path: *const u16,
            attr: u32,
            info: *mut ShFileInfo,
            cb: u32,
            flags: u32,
        ) -> usize;
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
            dc: isize, x: i32, y: i32, hi: isize,
            cx: i32, cy: i32, step: u32, brush: isize, flags: u32,
        ) -> i32;
    }

    // Constants (SHGFI_LARGEICON = 0x0 for 32×32 system icons on high-DPI)
    const SHGFI_ICON: u32 = 0x100;
    const SHGFI_LARGEICON: u32 = 0x0;
    const SHGFI_USEFILEATTRIBUTES: u32 = 0x10;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const DIB_RGB_COLORS: u32 = 0;
    const BI_RGB: u32 = 0;
    const DI_NORMAL: u32 = 3;
    const ICON_SIZE: i32 = 32; // 32×32 source → downsampled to 16px CSS for sharp HiDPI

    // 1. Get system icon handle via SHGetFileInfoW
    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut shfi = ShFileInfo {
        hIcon: 0,
        iIcon: 0,
        dwAttributes: 0,
        szDisplayName: [0; 260],
        szTypeName: [0; 80],
    };
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
    let hicon = shfi.hIcon;

    // 2. Create a reliable 32-bit DIB section with direct memory pointer access
    let hdc = unsafe { CreateCompatibleDC(0) };
    if hdc == 0 {
        unsafe { DestroyIcon(hicon) };
        return Err("CreateCompatibleDC failed".into());
    }

    let bmi = BitmapInfo {
        bmiHeader: BitmapInfoHeader {
            biSize: std::mem::size_of::<BitmapInfoHeader>() as u32,
            biWidth: ICON_SIZE,
            biHeight: -ICON_SIZE, // negative = top-down DIB
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
    let hbitmap = unsafe {
        CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut p_bits, 0, 0)
    };

    if hbitmap == 0 || p_bits.is_null() {
        unsafe { DeleteDC(hdc); DestroyIcon(hicon) };
        return Err("CreateDIBSection failed".into());
    }

    let old_obj = unsafe { SelectObject(hdc, hbitmap) };

    // 3. Draw the icon into the DIB section
    let draw_res = unsafe {
        DrawIconEx(hdc, 0, 0, hicon, ICON_SIZE, ICON_SIZE, 0, 0, DI_NORMAL)
    };

    if draw_res == 0 {
        unsafe {
            SelectObject(hdc, old_obj);
            DeleteObject(hbitmap);
            DeleteDC(hdc);
            DestroyIcon(hicon);
        };
        return Err("DrawIconEx failed".into());
    }

    // 4. Copy raw pixel data directly from the DIB section's memory
    let buffer_size = (ICON_SIZE * ICON_SIZE * 4) as usize;
    let mut pixels = vec![0u8; buffer_size];
    unsafe {
        std::ptr::copy_nonoverlapping(p_bits as *const u8, pixels.as_mut_ptr(), buffer_size);
    }

    // 5. Cleanup GDI resources
    unsafe {
        SelectObject(hdc, old_obj);
        DeleteObject(hbitmap);
        DeleteDC(hdc);
        DestroyIcon(hicon);
    };

    // 6. Convert BGRA → RGBA and fix potential missing Alpha channels
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2); // B ↔ R
        // Fallback: If alpha is 0 but color exists, force it to opaque
        if chunk[3] == 0 && (chunk[0] != 0 || chunk[1] != 0 || chunk[2] != 0) {
            chunk[3] = 255;
        }
    }

    // 7. Encode as PNG → base64
    use image::{ImageBuffer, ImageEncoder, Rgba};
    let img = ImageBuffer::<Rgba<u8>, _>::from_raw(ICON_SIZE as u32, ICON_SIZE as u32, pixels)
        .ok_or("failed to create image buffer")?;

    let mut png_bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png_bytes)
        .write_image(&img, ICON_SIZE as u32, ICON_SIZE as u32, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;

    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png_bytes);
    Ok(format!("data:image/png;base64,{}", b64))
}

/// Stub for non-Windows platforms.
#[cfg(not(target_os = "windows"))]
pub fn get_file_icon_base64(_path: &str) -> Result<String, String> {
    Err("icon extraction not supported on this platform".into())
}
