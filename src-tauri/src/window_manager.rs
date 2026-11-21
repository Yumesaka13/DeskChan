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
    /// Set while a drag is active so monitor changes do not resize the overlay mid-gesture.
    pub dragging: AtomicBool,
    /// Reordering the overlay during a native menu's modal loop can dismiss it.
    native_menu_open: AtomicBool,
}

impl DeskState {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(true),
            dragging: AtomicBool::new(false),
            native_menu_open: AtomicBool::new(false),
        }
    }

    pub fn with_native_menu<T>(
        &self,
        show: impl FnOnce() -> Result<Option<T>, String>,
    ) -> Result<Option<T>, String> {
        if self.native_menu_open.swap(true, Ordering::Relaxed) {
            return Ok(None);
        }
        let result = show();
        self.native_menu_open.store(false, Ordering::Relaxed);
        result
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
    pub const WM_ACTIVATE: u32 = 0x0006;
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
    pub const SWP_NOSENDCHANGING: u32 = 0x0400;

    // SetWindowPos flags composition
    pub const SWP_NOSIZE_NOMOVE_NOACTIVATE: u32 = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;

    // GetWindow relationships
    pub const GW_HWNDPREV: u32 = 3;

    // Coordinate exile (Win+D sends windows to -32000). The threshold must
    // stay far below any legitimate monitor layout - displays positioned
    // left/above the primary have negative coordinates, and a blanket
    // -10000 cutoff used to break two 5120px ultrawides or similar setups
    // by blocking the app's own work-area moves (and caching the failure
    // forever in the polling loop).
    pub const COORDINATE_EXILE_THRESHOLD: i32 = -30000;
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
        let panes = crate::materials::handles();
        let mut prev = GetWindow(host, GW_HWNDPREV);
        while panes.contains(&prev) {
            prev = GetWindow(prev, GW_HWNDPREV);
        }
        if prev == our_hwnd {
            crate::materials::align_below(our_hwnd, &panes);
            return;
        }
        // At this point Windows has promoted the desktop for Show Desktop.
        // HWND_TOP would move this full-virtual-screen overlay above normal
        // secondary taskbars. Leave the last valid desktop-relative position
        // untouched until Explorer restores a normal anchor.
        if prev == 0 || GetWindowLongW(prev, GWL_EXSTYLE) & WS_EX_TOPMOST != 0 {
            return;
        }
        SetWindowPos(
            our_hwnd,
            prev,
            0,
            0,
            0,
            0,
            SWP_NOSIZE_NOMOVE_NOACTIVATE | SWP_NOSENDCHANGING,
        );
        crate::materials::align_below(our_hwnd, &panes);
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
            // Allow WebView keyboard focus without raising the desktop on a
            // click. Only pin_above_desktop may change the overlay's Z-order.
            wp.flags |= SWP_NOZORDER;

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
    let result = CallWindowProcW(
        ORIGINAL_WNDPROC.load(Ordering::Relaxed),
        hwnd,
        msg,
        wparam,
        lparam,
    );
    if msg == WM_ACTIVATE && wparam & 0xffff != 0 {
        // Some activation paths reorder the window without a position
        // request. Restore its place while keeping keyboard focus.
        if let Some((host, _)) = desktop_anchor() {
            pin_above_desktop(hwnd, host);
        }
    }
    result
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

        let Some(window) = app.get_webview_window("main") else {
            continue;
        };
        // window_handle() can fail if the window is being torn down - skip
        // this tick instead of panicking the thread (a panic would silently
        // kill the Z-order defense for the rest of the session).
        let Ok(handle) = window.window_handle() else {
            continue;
        };
        let our_hwnd = match handle.as_raw() {
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
        if virtual_bounds != Some(bounds) && !state.dragging.load(Ordering::Relaxed) {
            let moved = unsafe {
                crate::win32::SetWindowPos(
                    our_hwnd,
                    0,
                    bounds.0 as i32,
                    bounds.1 as i32,
                    bounds.2 as i32,
                    bounds.3 as i32,
                    constants::SWP_NOZORDER | constants::SWP_NOACTIVATE,
                )
            };
            // Only trust the cache when the call actually succeeded - a
            // failure (or a wndproc veto) must be retried next tick instead
            // of being written off forever.
            if moved != 0 {
                virtual_bounds = Some(bounds);
            }
        }

        // Keep the overlay stable while Windows tracks a native menu.
        if !state.native_menu_open.load(Ordering::Relaxed) {
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
