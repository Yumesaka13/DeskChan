//! DeskChan window manager.
//!
//! The overlay is "glued to the desktop" via a Z-order invariant: our window
//! must sit IMMEDIATELY above the SHELLDLL_DefView host (Progman/WorkerW) —
//! below every application window, above the wallpaper. The polling thread
//! (33ms) re-asserts this. This also survives Win+D: when the desktop is
//! raised, we simply follow it up; when apps return, they sit above us.
//!
//! Additional mechanisms ensure the window survives Win+D (Show Desktop):
//! 1. AppBar registration — SHAppBarMessage(ABM_NEW/QUERYPOS/SETPOS) grants
//!    system-level immunity from Win+D's window enumeration (same as taskbar).
//! 2. WndProc replacement — intercepts WM_SHOWWINDOW, SC_MINIMIZE,
//!    WM_WINDOWPOSCHANGING, and WM_SIZE to block hide/minimize/coordinate
//!    exile, and answers WM_NCHITTEST with HTCLIENT so the overlay can never
//!    be user-dragged or user-resized.
//!
//! Desktop icon management: hides the native SysListView32 on startup,
//! shows it on quit. Files never leave the desktop — we just hide the icons
//! and render our own overlay.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

// ── Shared state ───────────────────────────────────────────────────────────

pub struct DeskState {
    pub running: AtomicBool,
    /// Set by JS when pointer-event drag is active — prevents any window state changes.
    pub dragging: AtomicBool,
}

impl DeskState {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(true),
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
    pub const WS_EX_TOPMOST: i32 = 0x8;

    // Window styles
    pub const WS_MINIMIZEBOX: i32 = 0x00020000;
    pub const WS_MAXIMIZEBOX: i32 = 0x00010000;
    pub const WS_THICKFRAME: i32 = 0x00040000;
    pub const WS_CAPTION: i32 = 0x00C00000;

    // GWL indices
    pub const GWL_EXSTYLE: i32 = -20;
    pub const GWL_STYLE: i32 = -16;
    pub const GWLP_WNDPROC: i32 = -4;

    // Window messages
    pub const WM_SHOWWINDOW: u32 = 0x0018;
    pub const WM_WINDOWPOSCHANGING: u32 = 0x0046;
    pub const WM_SYSCOMMAND: u32 = 0x0112;
    pub const WM_SIZE: u32 = 0x0005;
    pub const WM_NCHITTEST: u32 = 0x0084;

    // Message parameters
    pub const SC_MINIMIZE: usize = 0xF020;
    pub const SIZE_MINIMIZED: usize = 1;
    pub const HTCLIENT: isize = 1;
    pub const SWP_HIDEWINDOW: u32 = 0x0080;
    pub const SWP_NOMOVE: u32 = 0x0002;
    pub const SWP_NOSIZE: u32 = 0x0001;
    pub const SWP_NOZORDER: u32 = 0x0004;
    pub const SWP_NOACTIVATE: u32 = 0x0010;
    pub const SWP_FRAMECHANGED: u32 = 0x0020;

    // SetWindowPos flags composition
    pub const SWP_NOSIZE_NOMOVE_NOACTIVATE: u32 = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;

    // GetWindow relationships
    pub const GW_HWNDPREV: u32 = 3;

    // SetWindowPos special hwndInsertAfter values
    pub const HWND_TOP: isize = 0;

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
        fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, f: u32) -> i32;
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

        // Strip minimize/maximize boxes AND the resize frame + caption.
        // Bug fix: an undecorated-but-resizable window still carries
        // WS_THICKFRAME — it painted a visible edge on the left at startup
        // and let users drag-resize the overlay. SWP_FRAMECHANGED is required
        // for the style change to take effect.
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        SetWindowLongW(
            hwnd,
            GWL_STYLE,
            style & !WS_MINIMIZEBOX & !WS_MAXIMIZEBOX & !WS_THICKFRAME & !WS_CAPTION,
        );
        SetWindowPos(
            hwnd,
            0,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );

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

    // Drop to the desktop layer right away — a freshly created window sits
    // on top of every app opened before us and, being NOACTIVATE, would
    // never be lowered by clicks.
    pin_above_desktop(hwnd);

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

/// Find the desktop shell windows as (host, listview):
/// - host: the top-level Progman or WorkerW that contains SHELLDLL_DefView —
///   the Z-order anchor the overlay is pinned above
/// - listview: the SysListView32 inside it that renders desktop icons
///
/// Searches both Progman → SHELLDLL_DefView → SysListView32 (classic)
/// and WorkerW → SHELLDLL_DefView → SysListView32 (modern Windows 10/11).
#[cfg(target_os = "windows")]
fn find_desktop_windows() -> Option<(isize, isize)> {
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
        // Try Progman first (pre-Win10, and Win11 22H2+ hosts DefView here)
        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman != 0 {
            let def = FindWindowExW(progman, 0, shelldll.as_ptr(), std::ptr::null());
            if def != 0 {
                let lv = FindWindowExW(def, 0, syslist.as_ptr(), std::ptr::null());
                if lv != 0 {
                    return Some((progman, lv));
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
                    return Some((hwnd, lv));
                }
            }
            hwnd = FindWindowExW(0, hwnd, workerw.as_ptr(), std::ptr::null());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn find_desktop_listview() -> Option<isize> {
    find_desktop_windows().map(|(_, lv)| lv)
}

/// Enforce the desktop-glue invariant: our window sits IMMEDIATELY above the
/// DefView host in the Z-order — below every app window, above the wallpaper
/// and icons. Idempotent and cheap (read-only when already in place), so it
/// is safe to call every polling tick.
///
/// Bug fix: without this, the overlay stayed wherever window creation put it
/// (on top of every app started earlier) — WS_EX_NOACTIVATE means clicks
/// never re-order it, so it "sometimes covered other applications".
#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
fn pin_above_desktop(our_hwnd: isize) {
    use constants::*;

    extern "system" {
        fn GetWindow(h: isize, cmd: u32) -> isize;
        fn GetWindowLongW(h: isize, i: i32) -> i32;
        fn SetWindowPos(h: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, f: u32) -> i32;
    }

    let Some((host, _)) = find_desktop_windows() else { return };
    unsafe {
        let prev = GetWindow(host, GW_HWNDPREV);
        if prev == our_hwnd {
            return; // already glued
        }
        // Inserting after a TOPMOST window would catapult us into the
        // topmost band (covering every app — the very bug we're fixing).
        // Happens right after Win+D, when the desktop sits directly under
        // the topmost band. HWND_TOP only tops the non-topmost band.
        let insert_after = if prev == 0 || GetWindowLongW(prev, GWL_EXSTYLE) & WS_EX_TOPMOST != 0 {
            HWND_TOP
        } else {
            prev
        };
        SetWindowPos(our_hwnd, insert_after, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE);
    }
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

        // Everything is client area — no resize borders, no drag regions.
        // The overlay must never be user-movable or user-resizable.
        WM_NCHITTEST => return HTCLIENT,

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
fn polling_loop(app: tauri::AppHandle, state: Arc<DeskState>) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let poll_interval = std::time::Duration::from_millis(33); // ~30 fps

    while state.running.load(Ordering::Relaxed) {
        std::thread::sleep(poll_interval);

        // Skip while a pointer drag is active — re-ordering our own window
        // mid-drag could disturb WebView2's pointer capture.
        if state.dragging.load(Ordering::Relaxed) {
            continue;
        }

        let Some(window) = app.get_webview_window("main") else {
            continue;
        };
        let our_hwnd = match window.window_handle().unwrap().as_raw() {
            RawWindowHandle::Win32(wh) => wh.hwnd.get() as isize,
            _ => 0,
        };
        if our_hwnd == 0 {
            continue;
        }

        // Re-assert the desktop-glue invariant. This subsumes the old
        // Win+D "counter-attack": when Win+D raises the desktop above us,
        // we follow it up; apps the user re-activates go above us again.
        pin_above_desktop(our_hwnd);
    }
}

// Stub for non-Windows platforms
#[cfg(not(target_os = "windows"))]
fn polling_loop(_app: tauri::AppHandle, _state: Arc<DeskState>) {}

// ── File icon extraction ──────────────────────────────────────────────────

/// Extract the file's shell icon and return it as a base64 PNG data URL.
///
/// Resolves the system image-list index via SHGFI_SYSICONINDEX — this yields
/// the file's REAL icon. (The previous SHGFI_USEFILEATTRIBUTES approach never
/// touched the file, so every .exe got the same generic icon — a major cause
/// of the "doesn't look native" complaint.) Then pulls the largest available
/// bitmap: SHIL_JUMBO (256) → SHIL_EXTRALARGE (48) → legacy 32px fallback.
/// The frontend downscales to 48px CSS, staying crisp at any DPI.
#[cfg(target_os = "windows")]
pub fn get_file_icon_base64(path: &str) -> Result<String, String> {
    let (pixels, size) = icon_ffi::extract_icon_rgba(path)?;

    use image::{ImageBuffer, ImageEncoder, Rgba};
    let img = ImageBuffer::<Rgba<u8>, _>::from_raw(size, size, pixels)
        .ok_or("failed to create image buffer")?;

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
    use std::ffi::c_void;

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
    #[repr(C)]
    struct Guid {
        d1: u32,
        d2: u16,
        d3: u16,
        d4: [u8; 8],
    }

    // IID_IImageList {46EB5926-582E-4017-9FDF-E8998DAA0950}
    const IID_IMAGE_LIST: Guid = Guid {
        d1: 0x46EB5926,
        d2: 0x582E,
        d3: 0x4017,
        d4: [0x9F, 0xDF, 0xE8, 0x99, 0x8D, 0xAA, 0x09, 0x50],
    };

    const SHGFI_ICON: u32 = 0x100;
    const SHGFI_LARGEICON: u32 = 0x0;
    const SHGFI_SYSICONINDEX: u32 = 0x4000;
    const SHGFI_USEFILEATTRIBUTES: u32 = 0x10;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const SHIL_EXTRALARGE: i32 = 2; // 48×48
    const SHIL_JUMBO: i32 = 4; // 256×256
    const ILD_TRANSPARENT: u32 = 0x1;
    const DIB_RGB_COLORS: u32 = 0;
    const BI_RGB: u32 = 0;
    const DI_NORMAL: u32 = 3;
    const COINIT_APARTMENTTHREADED: u32 = 0x2;

    extern "system" {
        fn SHGetFileInfoW(path: *const u16, attr: u32, info: *mut ShFileInfo, cb: u32, flags: u32) -> usize;
        fn SHGetImageList(iImageList: i32, riid: *const Guid, ppv: *mut *mut c_void) -> i32;
        fn CreateCompatibleDC(h: isize) -> isize;
        fn CreateDIBSection(hdc: isize, pbmi: *const BitmapInfo, usage: u32, ppvBits: *mut *mut c_void, hSection: isize, offset: u32) -> isize;
        fn SelectObject(h: isize, o: isize) -> isize;
        fn DeleteDC(h: isize) -> i32;
        fn DeleteObject(o: isize) -> i32;
        fn DestroyIcon(i: isize) -> i32;
        fn DrawIconEx(dc: isize, x: i32, y: i32, hi: isize, cx: i32, cy: i32, step: u32, brush: isize, flags: u32) -> i32;
        fn CoInitializeEx(pv: *mut c_void, co: u32) -> i32;
        fn CoUninitialize();
    }

    /// Balances CoInitializeEx/CoUninitialize (shell APIs want COM ready on
    /// the calling thread — Tauri command threads are not guaranteed to be).
    struct ComGuard(bool);
    impl ComGuard {
        fn init() -> Self {
            // S_OK / S_FALSE (>= 0) must be balanced; RPC_E_CHANGED_MODE must not
            Self(unsafe { CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED) } >= 0)
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Get an HICON of the given shell image-list size (SHIL_*) for a
    /// system image-list index, via the IImageList COM interface.
    fn imagelist_icon(which: i32, index: i32) -> Option<isize> {
        // IImageList vtable: 0-2 IUnknown (QI/AddRef/Release), 3 Add,
        // 4 ReplaceIcon, 5 SetOverlayImage, 6 Replace, 7 AddMasked,
        // 8 Draw, 9 Remove, 10 GetIcon — stable public ABI since Vista.
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
            let hr = get_icon(list, index, ILD_TRANSPARENT, &mut hicon);
            release(list);
            (hr == 0 && hicon != 0).then_some(hicon)
        }
    }

    /// Render an HICON into an RGBA buffer of `size`×`size` via a top-down
    /// 32-bit DIB section (reliable pixel access). Consumes the icon.
    fn render_icon_rgba(hicon: isize, size: i32) -> Result<Vec<u8>, String> {
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
        let mut cleanup = Cleanup { hdc, hbitmap: 0, old_obj: 0, hicon };
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
        if hbitmap == 0 || p_bits.is_null() {
            return Err("CreateDIBSection failed".into());
        }
        cleanup.hbitmap = hbitmap;
        cleanup.old_obj = unsafe { SelectObject(hdc, hbitmap) };

        if unsafe { DrawIconEx(hdc, 0, 0, hicon, size, size, 0, 0, DI_NORMAL) } == 0 {
            return Err("DrawIconEx failed".into());
        }

        let buffer_size = (size * size * 4) as usize;
        let mut pixels = vec![0u8; buffer_size];
        unsafe {
            std::ptr::copy_nonoverlapping(p_bits as *const u8, pixels.as_mut_ptr(), buffer_size);
        }
        drop(cleanup);

        // BGRA → RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        // Legacy mask-based icons have no alpha channel at all → whole image
        // is transparent. Only then force non-black pixels opaque (a per-pixel
        // fix would corrupt antialiased edges of modern icons).
        if pixels.chunks_exact(4).all(|c| c[3] == 0) {
            for chunk in pixels.chunks_exact_mut(4) {
                if chunk[0] != 0 || chunk[1] != 0 || chunk[2] != 0 {
                    chunk[3] = 255;
                }
            }
        }
        Ok(pixels)
    }

    /// Jumbo (256) quirk: icons without 256px art get stamped as a small
    /// image in the top-left corner of the canvas. Detect via the opaque
    /// bounding box; such icons fall back to SHIL_EXTRALARGE.
    fn is_corner_stamped(pixels: &[u8], size: u32) -> bool {
        let mut max_x = 0u32;
        let mut max_y = 0u32;
        let mut any = false;
        for (i, chunk) in pixels.chunks_exact(4).enumerate() {
            if chunk[3] > 8 {
                let x = (i as u32) % size;
                let y = (i as u32) / size;
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                any = true;
            }
        }
        !any || (max_x <= 64 && max_y <= 64)
    }

    /// Extract the best available icon as (rgba_pixels, size).
    pub fn extract_icon_rgba(path: &str) -> Result<(Vec<u8>, u32), String> {
        let _com = ComGuard::init();
        let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
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
                SHGFI_SYSICONINDEX,
            )
        };
        if ok != 0 {
            if let Some(hicon) = imagelist_icon(SHIL_JUMBO, shfi.iIcon) {
                if let Ok(px) = render_icon_rgba(hicon, 256) {
                    if !is_corner_stamped(&px, 256) {
                        return Ok((px, 256));
                    }
                }
            }
            if let Some(hicon) = imagelist_icon(SHIL_EXTRALARGE, shfi.iIcon) {
                if let Ok(px) = render_icon_rgba(hicon, 48) {
                    return Ok((px, 48));
                }
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
        render_icon_rgba(shfi.hIcon, 32).map(|px| (px, 32))
    }
}

/// Stub for non-Windows platforms.
#[cfg(not(target_os = "windows"))]
pub fn get_file_icon_base64(_path: &str) -> Result<String, String> {
    Err("icon extraction not supported on this platform".into())
}
