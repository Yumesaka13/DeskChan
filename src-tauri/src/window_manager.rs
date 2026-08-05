//! DeskChan window manager.
//!
//! The overlay is "glued to the desktop" via a Z-order invariant: our window
//! must sit IMMEDIATELY above the SHELLDLL_DefView host (Progman/WorkerW) -
//! below every application window, above the wallpaper. The polling thread
//! (33ms) re-asserts this. This also survives Win+D: when the desktop is
//! raised, we simply follow it up; when apps return, they sit above us.
//!
//! Additional mechanisms ensure the window survives Win+D (Show Desktop):
//! 1. WndProc replacement - intercepts WM_SHOWWINDOW, SC_MINIMIZE,
//!    WM_WINDOWPOSCHANGING, and WM_SIZE to block hide/minimize/coordinate
//!    exile, and answers WM_NCHITTEST with HTCLIENT so the overlay can never
//!    be user-dragged or user-resized.
//! 2. The polling loop restores the desktop-relative Z-order after Win+D.
//!
//! Desktop icon management: hides the native SysListView32 on startup,
//! shows it on quit. Files never leave the desktop - we just hide the icons
//! and render our own overlay.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

// -- Shared state -----------------------------------------------------------

pub struct DeskState {
    pub running: AtomicBool,
    /// Set by JS when pointer-event drag is active - prevents any window state changes.
    pub dragging: AtomicBool,
    /// Set while Explorer owns the full desktop context menu. Reordering the
    /// overlay during that modal loop dismisses the shell popup immediately.
    pub native_desktop_menu_open: AtomicBool,
}

impl DeskState {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(true),
            dragging: AtomicBool::new(false),
            native_desktop_menu_open: AtomicBool::new(false),
        }
    }
}

// -- Win32 constants --------------------------------------------------------
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
    pub const WS_SYSMENU: i32 = 0x00080000;
    pub const WS_POPUP: i32 = 0x80000000u32 as i32;

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
    pub const WM_NCPAINT: u32 = 0x0085;
    pub const WM_NCACTIVATE: u32 = 0x0086;

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

    // Coordinate exile threshold (Win+D sends windows to -32000)
    pub const COORDINATE_EXILE_THRESHOLD: i32 = -10000;
}

// -- Init: styles + WndProc replacement -------------------------------------

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
pub fn init(window: &WebviewWindow) {
    use constants::*;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use crate::win32::{GetWindowLongW, SetWindowLongW};

    let hwnd = match window.window_handle().ok().map(|r| match r.as_raw() {
        RawWindowHandle::Win32(w) => w.hwnd.get() as isize,
        _ => 0isize,
    }) {
        Some(x) => x,
        None => return,
    };

    // FFI declarations (unique to init - shared ones live in crate::win32)
    extern "system" {
        fn GetWindowLongPtrW(h: isize, i: i32) -> isize;
        fn SetWindowLongPtrW(h: isize, i: i32, v: isize) -> isize;
    }

    unsafe {
        // -- Window styles --------------------------------------------
        // Tool window (no taskbar entry). The desktop must be allowed to
        // activate when clicked so WebView2 can receive Ctrl+V and other
        // desktop keyboard shortcuts.
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(
            hwnd,
            GWL_EXSTYLE,
            (ex_style | WS_EX_TOOLWINDOW) & !WS_EX_NOACTIVATE,
        );

        // Strip every frame style (see strip_frame_styles for the WS_POPUP
        // rationale and the phantom-title-bar / draggable-left-edge history).
        //
        // NOTE: tauri.conf.json must keep `"shadow": false`. With the default
        // shadow enabled, tao implements undecorated shadows by KEEPING
        // WS_CAPTION and hiding it in WM_NCCALCSIZE - stripping the style
        // here then desyncs that compensation, which showed up as a phantom
        // title-bar band at the top and an outer size larger than requested.
        strip_frame_styles(hwnd);

        // -- WndProc replacement --------------------------------------
        // Replace window procedure to intercept hide/minimize messages.
        // Uses CallWindowProcW for safe chaining (no transmute needed).
        let orig = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        ORIGINAL_WNDPROC.store(orig, Ordering::Relaxed);
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wndproc as *const () as isize);
    }

    // Start interactive - cursor polling will toggle click-through later
    let _ = window.set_ignore_cursor_events(false);

    // Drop to the desktop layer right away - a freshly created window sits
    // on top of every app opened before us and, being NOACTIVATE, would
    // never be lowered by clicks. The polling loop retries if the shell
    // isn't ready yet.
    if let Some((host, lv)) = desktop_anchor() {
        pin_above_desktop(hwnd, host);
        // Hide native desktop icons - our overlay replaces them entirely
        if let Some(lv) = lv {
            const SW_HIDE: i32 = 0;
            unsafe { crate::win32::ShowWindow(lv, SW_HIDE) };
        }
    }
}

/// Show the desktop's SysListView32 - restore native desktop icons.
#[cfg(target_os = "windows")]
pub fn show_desktop_icons() {
    if let Some(list_view) = desktop_list_view() {
        const SW_SHOW: i32 = 5;
        unsafe { crate::win32::ShowWindow(list_view, SW_SHOW) };
    }
}

/// Trigger Windows' native Show Desktop toggle (the same action as Win+D).
/// Keeping this at the OS level preserves Explorer's normal handling across
/// all monitors and avoids trying to minimize other applications ourselves.
#[cfg(target_os = "windows")]
pub fn toggle_show_desktop() {
    extern "system" {
        fn keybd_event(virtual_key: u8, scan_code: u8, flags: u32, extra_info: usize);
    }

    const VK_LWIN: u8 = 0x5B;
    const VK_D: u8 = 0x44;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    unsafe {
        keybd_event(VK_LWIN, 0, 0, 0);
        keybd_event(VK_D, 0, 0, 0);
        keybd_event(VK_D, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, 0);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn toggle_show_desktop() {}

/// Find the desktop shell windows as (host, listview):
/// - host: the top-level Progman or WorkerW that contains SHELLDLL_DefView -
///   the Z-order anchor the overlay is pinned above
/// - listview: the SysListView32 inside it that renders desktop icons
///
/// Searches both Progman -> SHELLDLL_DefView -> SysListView32 (classic)
/// and WorkerW -> SHELLDLL_DefView -> SysListView32 (modern Windows 10/11).
#[cfg(target_os = "windows")]
fn find_desktop_windows() -> Option<(isize, isize)> {
    use crate::win32::{wide, FindWindowExW, FindWindowW};

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
            // Some Win11 builds nest DefView one level deeper:
            // Progman -> WorkerW -> SHELLDLL_DefView -> SysListView32
            let workerw_cls = wide("WorkerW");
            let mut ww = FindWindowExW(progman, 0, workerw_cls.as_ptr(), std::ptr::null());
            while ww != 0 {
                let def = FindWindowExW(ww, 0, shelldll.as_ptr(), std::ptr::null());
                if def != 0 {
                    let lv = FindWindowExW(def, 0, syslist.as_ptr(), std::ptr::null());
                    if lv != 0 {
                        return Some((progman, lv));
                    }
                }
                ww = FindWindowExW(progman, ww, workerw_cls.as_ptr(), std::ptr::null());
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
pub fn desktop_list_view() -> Option<isize> {
    find_desktop_windows().map(|(_, lv)| lv)
}

/// Resolve the Z-order anchor for this tick, with a degraded fallback.
///
/// Bug fix ("sometimes starts behind the desktop and Win+D knocks it away"):
/// when SHELLDLL_DefView is not findable yet - shell still starting, or an
/// Explorer restart recreating its window tree - the old code skipped
/// pinning entirely, leaving the overlay wherever window creation put it,
/// often BELOW the desktop and outside the Win+D-defense invariant. Falling
/// back to the bare Progman window (which always exists) keeps the overlay
/// glued even before the icon list view is born; the exact host takes over
/// on a later tick once DefView appears.
#[cfg(target_os = "windows")]
fn desktop_anchor() -> Option<(isize, Option<isize>)> {
    use crate::win32::{wide, FindWindowW};
    if let Some((host, lv)) = find_desktop_windows() {
        return Some((host, Some(lv)));
    }
    let progman = unsafe { FindWindowW(wide("Progman").as_ptr(), std::ptr::null()) };
    (progman != 0).then_some((progman, None))
}

/// Enforce the desktop-glue invariant: our window sits IMMEDIATELY above the
/// anchor (DefView host) in the Z-order - below every app window, above the
/// wallpaper and icons. It deliberately refuses to promote the overlay when
/// Explorer is immediately below the topmost band: that state occurs during
/// Win+D, and promoting a virtual-desktop-sized window there covers secondary
/// taskbars that live in the ordinary Z-order band.
///
/// Bug fix: without this, the overlay stayed wherever window creation put it
/// (on top of every app started earlier) - WS_EX_NOACTIVATE means clicks
/// never re-order it, so it "sometimes covered other applications".
#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
fn pin_above_desktop(our_hwnd: isize, host: isize) {
    use crate::win32::{GetWindow, GetWindowLongW, SetWindowPos};
    use constants::*;

    unsafe {
        let prev = GetWindow(host, GW_HWNDPREV);
        if prev == our_hwnd {
            return; // already glued
        }
        // At this point Windows has promoted the desktop for Show Desktop.
        // HWND_TOP would move this full-virtual-screen overlay above normal
        // secondary taskbars. Leave the last valid desktop-relative position
        // untouched until Explorer restores a normal anchor.
        if prev == 0 || GetWindowLongW(prev, GWL_EXSTYLE) & WS_EX_TOPMOST != 0 {
            return;
        }
        SetWindowPos(our_hwnd, prev, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE);
    }
}

#[cfg(target_os = "windows")]
static ORIGINAL_WNDPROC: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Custom window procedure. Blocks all attempts to hide, minimize, or
/// coordinate-exile the window (Win+D's three attack vectors).
#[cfg(target_os = "windows")]
unsafe extern "system" fn wndproc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    use constants::*;

    // While a native shell context menu is open, hand its messages to
    // IContextMenu2/3 so dynamic submenus ("Send To", "Open With") populate.
    if let Some(result) = crate::shell_menu::forward_menu_msg(msg, wparam, lparam) {
        return result;
    }

    match msg {
        // Block hide
        WM_SHOWWINDOW if wparam == 0 => return 0,

        // Block minimize via system menu
        WM_SYSCOMMAND if (wparam & 0xFFF0) == SC_MINIMIZE => return 0,

        // Everything is client area - no resize borders, no drag regions.
        // The overlay must never be user-movable or user-resizable.
        WM_NCHITTEST => return HTCLIENT,

        // Suppress ALL non-client painting. Without this, activating the
        // window (clicking it focuses the WebView2 child) lets the default
        // handlers repaint a frame - the "title bar comes back after a
        // click" bug. Standard borderless-window practice.
        WM_NCPAINT => return 0,
        WM_NCACTIVATE => return 1,

        // Block SIZE_MINIMIZED -> prevents WebView2 from stopping render
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

            // Strip SWP_HIDEWINDOW - prevent hiding
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
    CallWindowProcW(
        ORIGINAL_WNDPROC.load(Ordering::Relaxed),
        hwnd,
        msg,
        wparam,
        lparam,
    )
}

// -- Window sizing ----------------------------------------------------------

/// Position and size the window to cover the combined monitor work areas.
pub fn fit_to_work_area<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (x, y, w, h) = get_work_area(app);

    // On Windows, set the OUTER rect directly. Tauri's set_size sets the
    // inner size and lets tao pad it via AdjustWindowRectEx with its cached
    // styles - that padding made the overlay overhang the work area.
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        if let Ok(handle) = window.window_handle() {
            if let RawWindowHandle::Win32(wh) = handle.as_raw() {
                unsafe {
                    crate::win32::SetWindowPos(
                        wh.hwnd.get() as isize,
                        0,
                        x as i32,
                        y as i32,
                        w as i32,
                        h as i32,
                        constants::SWP_NOZORDER | constants::SWP_NOACTIVATE,
                    );
                }
                return;
            }
        }
    }

    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
    let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
}

/// Returns the union of all monitor work areas as (x, y, width, height) in
/// physical pixels. Unlike the virtual-screen metrics, monitor work areas
/// exclude the taskbar on every display. The overlay must not occupy those
/// strips: after Win+D Explorer can place a secondary taskbar in the normal
/// Z-order band, where a full-virtual-screen window would cover it.
#[allow(non_snake_case)]
fn get_work_area<R: Runtime>(_app: &tauri::AppHandle<R>) -> (f64, f64, f64, f64) {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct Rect {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }

        #[repr(C)]
        struct MonitorInfo {
            cb_size: u32,
            rc_monitor: Rect,
            rc_work: Rect,
            flags: u32,
        }

        extern "system" {
            fn EnumDisplayMonitors(
                hdc: isize,
                clip: *const Rect,
                callback: unsafe extern "system" fn(isize, isize, *mut Rect, isize) -> i32,
                data: isize,
            ) -> i32;
            fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
        }

        unsafe extern "system" fn collect_work_area(
            monitor: isize,
            _: isize,
            _: *mut Rect,
            data: isize,
        ) -> i32 {
            let work_areas = &mut *(data as *mut Vec<Rect>);
            let mut info = MonitorInfo {
                cb_size: std::mem::size_of::<MonitorInfo>() as u32,
                rc_monitor: Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                rc_work: Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                flags: 0,
            };
            if GetMonitorInfoW(monitor, &mut info) != 0 {
                work_areas.push(info.rc_work);
            }
            1
        }

        let mut work_areas: Vec<Rect> = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                0,
                std::ptr::null(),
                collect_work_area,
                (&mut work_areas as *mut Vec<Rect>) as isize,
            );
        }
        if let Some(first) = work_areas.first().copied() {
            let bounds = work_areas.iter().fold(first, |bounds, work| Rect {
                left: bounds.left.min(work.left),
                top: bounds.top.min(work.top),
                right: bounds.right.max(work.right),
                bottom: bounds.bottom.max(work.bottom),
            });
            let width = bounds.right - bounds.left;
            let height = bounds.bottom - bounds.top;
            if width > 0 && height > 0 {
                return (
                    bounds.left as f64,
                    bounds.top as f64,
                    width as f64,
                    height as f64,
                );
            }
        }
    }
    (0.0, 0.0, 1920.0, 1080.0) // fallback
}

// -- Background threads -----------------------------------------------------

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
    let mut virtual_bounds = None;

    while state.running.load(Ordering::Relaxed) {
        std::thread::sleep(poll_interval);

        // Re-check after the sleep: quit_app clears the flag and restores
        // the native icons - a tick that was already sleeping must not wake
        // up and re-hide them during teardown.
        if !state.running.load(Ordering::Relaxed) {
            break;
        }

        // Skip while a pointer drag is active - re-ordering our own window
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

        // Monitor connections, resolutions, and arrangements can change at
        // runtime. Keep the one desktop overlay aligned with the complete
        // virtual screen, including displays positioned left/above primary.
        let bounds = get_work_area(&app);
        if virtual_bounds != Some(bounds) {
            unsafe {
                crate::win32::SetWindowPos(
                    our_hwnd,
                    0,
                    bounds.0 as i32,
                    bounds.1 as i32,
                    bounds.2 as i32,
                    bounds.3 as i32,
                    constants::SWP_NOZORDER | constants::SWP_NOACTIVATE,
                );
            }
            virtual_bounds = Some(bounds);
        }

        // Explorer owns the complete desktop context menu. Do not change its
        // Z-order or hide its list view while that menu's modal loop runs.
        if !state.native_desktop_menu_open.load(Ordering::Relaxed) {
            // Re-assert the desktop-glue invariant. This subsumes the old
            // Win+D "counter-attack": when Win+D raises the desktop above us,
            // we follow it up; apps the user re-activates go above us again.
            // The anchor is re-resolved every tick because Explorer moves
            // SHELLDLL_DefView between Progman and WorkerW at runtime.
            if let Some((host, lv)) = desktop_anchor() {
                pin_above_desktop(our_hwnd, host);

                // Re-hide the native icon list if it reappeared - Explorer
                // recreates/reshows it on restart, F5, or display changes.
                if let Some(lv) = lv {
                    if unsafe { crate::win32::IsWindowVisible(lv) } != 0 {
                        const SW_HIDE: i32 = 0;
                        unsafe { crate::win32::ShowWindow(lv, SW_HIDE) };
                    }
                }
            }
        }

        // Defensive: tao re-applies its cached styles on some events; if the
        // caption/resize frame ever reappear, strip them again.
        strip_frame_styles(our_hwnd);
    }
}

/// Enforce the frameless popup style. No-op when already clean.
///
/// History: undecorated-but-resizable still carried WS_THICKFRAME (visible
/// draggable left edge at startup); a later re-appearing caption came from
/// default non-client processing. Plain WS_POPUP without caption/sysmenu has
/// no non-client machinery at all, so nothing can ever draw a frame -
/// regardless of who processes WM_NCACTIVATE / WM_NCPAINT down the line.
/// SWP_FRAMECHANGED is required for style changes to take effect.
#[cfg(target_os = "windows")]
fn strip_frame_styles(hwnd: isize) {
    use crate::win32::{GetWindowLongW, SetWindowLongW, SetWindowPos};
    use constants::*;
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        let clean = (style
            & !WS_CAPTION
            & !WS_THICKFRAME
            & !WS_SYSMENU
            & !WS_MINIMIZEBOX
            & !WS_MAXIMIZEBOX)
            | WS_POPUP;
        if style != clean {
            SetWindowLongW(hwnd, GWL_STYLE, clean);
            SetWindowPos(
                hwnd,
                0,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }
}

// Stub for non-Windows platforms
#[cfg(not(target_os = "windows"))]
fn polling_loop(_app: tauri::AppHandle, _state: Arc<DeskState>) {}

// -- File icon extraction --------------------------------------------------

/// Extract the file's shell icon and return it as a base64 PNG data URL.
///
/// Resolves the system image-list index via SHGFI_SYSICONINDEX - this yields
/// the file's REAL icon. (The previous SHGFI_USEFILEATTRIBUTES approach never
/// touched the file, so every .exe got the same generic icon - a major cause
/// of the "doesn't look native" complaint.) Then pulls the largest available
/// bitmap: SHIL_JUMBO (256) -> SHIL_EXTRALARGE (48) -> legacy 32px fallback.
/// The frontend downscales to 48px CSS, staying crisp at any DPI.
#[cfg(target_os = "windows")]
pub fn get_file_icon_base64(path: &str) -> Result<String, String> {
    // Prefer a real shell thumbnail (images, videos, PDFs with providers);
    // files without one fall back to the crisp icon pipeline.
    let (pixels, size) = icon_ffi::extract_thumbnail_rgba(path, 96)
        .map_or_else(|| icon_ffi::extract_icon_rgba(path), Ok)?;

    use image::{ImageBuffer, ImageEncoder, Rgba};
    let mut img = ImageBuffer::<Rgba<u8>, _>::from_raw(size, size, pixels)
        .ok_or("failed to create image buffer")?;

    // Icons render at 48px CSS (96 physical at 2x DPI). Encoding the raw
    // 256px jumbo bitmap cost ~7x more PNG time + base64 payload for zero
    // visible gain - downscale first. (The corner-stamp check above needed
    // the full canvas, so this must happen after extraction.)
    //
    // resize() filters channels independently and documents a premultiplied-
    // alpha assumption; our canvas is transparent BLACK, so straight-alpha
    // resizing blended black into every antialiased edge (dark halo). Round-
    // trip through premultiplied alpha to keep edges clean.
    const MAX_ENCODE_SIZE: u32 = 96;
    let size = if size > MAX_ENCODE_SIZE {
        for p in img.pixels_mut() {
            let a = p[3] as u32;
            for c in 0..3 {
                p[c] = ((p[c] as u32 * a + 127) / 255) as u8;
            }
        }
        img = image::imageops::resize(
            &img,
            MAX_ENCODE_SIZE,
            MAX_ENCODE_SIZE,
            image::imageops::FilterType::Triangle,
        );
        for p in img.pixels_mut() {
            let a = p[3] as u32;
            if a > 0 {
                for c in 0..3 {
                    p[c] = ((p[c] as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        MAX_ENCODE_SIZE
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
    fn imagelist_icon(which: i32, index: i32) -> Option<isize> {
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
            let hr = get_icon(list, index, ILD_TRANSPARENT, &mut hicon);
            release(list);
            (hr == 0 && hicon != 0).then_some(hicon)
        }
    }

    /// Render an HICON into an RGBA buffer of `size`x`size` via a top-down
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
        let mut cleanup = Cleanup {
            hdc,
            hbitmap: 0,
            old_obj: 0,
            hicon,
        };
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

        // BGRA -> RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        // Legacy mask-based icons have no alpha channel at all -> whole image
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
            fn GetObjectW(h: isize, cb: i32, pv: *mut c_void) -> i32;
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
            if GetObjectW(
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
