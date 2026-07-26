//! Native Windows shell context menu for desktop icons.
//!
//! Right-clicking an icon shows the file's REAL Explorer menu (open, run as
//! admin, pin, send to, properties, …) via IShellFolder::GetUIObjectOf →
//! IContextMenu, using the same raw-FFI style as the icon extraction code.
//!
//! DeskChan-specific entries (e.g. "remove from cell") are appended after a
//! separator; the function returns which extra entry was picked, if any —
//! native verbs are invoked directly by the shell.

#[cfg(target_os = "windows")]
pub fn show(
    window: tauri::WebviewWindow,
    path: String,
    extra_items: Vec<String>,
) -> Result<Option<u32>, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let hwnd = match window.window_handle().ok().map(|h| match h.as_raw() {
        RawWindowHandle::Win32(w) => w.hwnd.get() as isize,
        _ => 0isize,
    }) {
        Some(h) if h != 0 => h,
        _ => return Err("no window handle".into()),
    };

    // TrackPopupMenuEx must run on the thread that owns the window. Tauri
    // commands run on worker threads, so hop to the main thread and wait.
    // No timeout: the menu's lifetime is user-controlled, and the sender is
    // dropped (recv errors out) if the closure never runs.
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(unsafe { menu_ffi::show_menu(hwnd, &path, &extra_items) });
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|_| "menu closure dropped".to_string())?
}

/// Forward a menu message to the active IContextMenu2/3 during the modal
/// TrackPopupMenuEx loop — this is what populates dynamic submenus like
/// "Send To" / "Open With" and renders owner-drawn shell-extension items.
/// Called from the window procedure; returns None when no menu is active.
#[cfg(target_os = "windows")]
pub fn forward_menu_msg(msg: u32, wparam: usize, lparam: isize) -> Option<isize> {
    menu_ffi::forward_menu_msg(msg, wparam, lparam)
}

#[cfg(not(target_os = "windows"))]
pub fn show(
    _window: tauri::WebviewWindow,
    _path: String,
    _extra_items: Vec<String>,
) -> Result<Option<u32>, String> {
    Err("native context menu not supported on this platform".into())
}

#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
mod menu_ffi {
    use std::ffi::c_void;

    #[repr(C)]
    struct Guid {
        d1: u32,
        d2: u16,
        d3: u16,
        d4: [u8; 8],
    }

    // IID_IShellFolder {000214E6-0000-0000-C000-000000000046}
    const IID_ISHELL_FOLDER: Guid = Guid {
        d1: 0x000214E6,
        d2: 0,
        d3: 0,
        d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46],
    };
    // IID_IContextMenu {000214E4-0000-0000-C000-000000000046}
    const IID_ICONTEXT_MENU: Guid = Guid {
        d1: 0x000214E4,
        d2: 0,
        d3: 0,
        d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46],
    };
    // IID_IContextMenu2 {000214F4-0000-0000-C000-000000000046}
    const IID_ICONTEXT_MENU2: Guid = Guid {
        d1: 0x000214F4,
        d2: 0,
        d3: 0,
        d4: [0xC0, 0, 0, 0, 0, 0, 0, 0x46],
    };
    // IID_IContextMenu3 {BCFCE0A0-EC17-11D0-8D10-00A0C90F2719}
    const IID_ICONTEXT_MENU3: Guid = Guid {
        d1: 0xBCFCE0A0,
        d2: 0xEC17,
        d3: 0x11D0,
        d4: [0x8D, 0x10, 0x00, 0xA0, 0xC9, 0x0F, 0x27, 0x19],
    };

    const ID_FIRST: u32 = 1;
    const ID_LAST: u32 = 0x7FFE;
    const ID_EXTRA_BASE: u32 = 0x8000;
    const CMF_NORMAL: u32 = 0;
    const MF_STRING: u32 = 0;
    const MF_SEPARATOR: u32 = 0x800;
    const TPM_RETURNCMD: u32 = 0x100;
    const TPM_RIGHTBUTTON: u32 = 0x2;
    const SW_SHOWNORMAL: i32 = 1;
    const WM_NULL: u32 = 0;
    const COINIT_APARTMENTTHREADED: u32 = 0x2;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct CmInvokeCommandInfo {
        cbSize: u32,
        fMask: u32,
        hwnd: isize,
        lpVerb: *const u8,
        lpParameters: *const u8,
        lpDirectory: *const u8,
        nShow: i32,
        dwHotKey: u32,
        hIcon: isize,
    }

    extern "system" {
        fn CoInitializeEx(pv: *mut c_void, co: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(pv: *mut c_void);
        fn SHParseDisplayName(
            name: *const u16,
            pbc: *mut c_void,
            ppidl: *mut *mut c_void,
            sfgao_in: u32,
            sfgao_out: *mut u32,
        ) -> i32;
        fn SHBindToParent(
            pidl: *const c_void,
            riid: *const Guid,
            ppv: *mut *mut c_void,
            ppidl_last: *mut *const c_void,
        ) -> i32;
        fn CreatePopupMenu() -> isize;
        fn DestroyMenu(menu: isize) -> i32;
        fn AppendMenuW(menu: isize, flags: u32, id: usize, item: *const u16) -> i32;
        fn TrackPopupMenuEx(menu: isize, flags: u32, x: i32, y: i32, hwnd: isize, tpm: *mut c_void) -> i32;
        fn GetCursorPos(p: *mut Point) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn PostMessageW(hwnd: isize, msg: u32, w: usize, l: isize) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Balances CoInitializeEx/CoUninitialize (S_OK / S_FALSE must be
    /// balanced; RPC_E_CHANGED_MODE must not).
    struct ComGuard(bool);
    impl ComGuard {
        fn init() -> Self {
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

    /// Releases a COM interface pointer on drop (vtable slot 2 = Release).
    struct ComPtr(*mut c_void);
    impl ComPtr {
        unsafe fn vtbl(&self) -> *const usize {
            *(self.0 as *mut *const usize)
        }
    }
    impl Drop for ComPtr {
        fn drop(&mut self) {
            if !self.0.is_null() {
                type ReleaseFn = unsafe extern "system" fn(*mut c_void) -> u32;
                unsafe {
                    let release: ReleaseFn = std::mem::transmute(*self.vtbl().add(2));
                    release(self.0);
                }
            }
        }
    }

    // ── IContextMenu2/3 menu-message forwarding ─────────────────────────
    // The shell populates dynamic submenus ("Send To", "Open With", …) and
    // draws owner-drawn items only when the menu owner's wndproc forwards
    // WM_INITMENUPOPUP / WM_MEASUREITEM / WM_DRAWITEM / WM_MENUCHAR to
    // IContextMenu2::HandleMenuMsg (slot 6) / IContextMenu3::HandleMenuMsg2
    // (slot 7). Only the main thread touches these statics, and only while
    // the modal TrackPopupMenuEx loop runs.
    use std::sync::atomic::{AtomicIsize, AtomicU8, Ordering};
    static ACTIVE_MENU_PTR: AtomicIsize = AtomicIsize::new(0);
    static ACTIVE_MENU_VER: AtomicU8 = AtomicU8::new(0); // 0 = none, 2, 3

    const WM_INITMENUPOPUP: u32 = 0x0117;
    const WM_DRAWITEM: u32 = 0x002B;
    const WM_MEASUREITEM: u32 = 0x002C;
    const WM_MENUCHAR: u32 = 0x0120;

    pub fn forward_menu_msg(msg: u32, wparam: usize, lparam: isize) -> Option<isize> {
        if !matches!(msg, WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR) {
            return None;
        }
        let ptr = ACTIVE_MENU_PTR.load(Ordering::Acquire) as *mut c_void;
        if ptr.is_null() {
            return None;
        }
        let vtbl = unsafe { *(ptr as *mut *const usize) };
        match ACTIVE_MENU_VER.load(Ordering::Acquire) {
            3 => {
                type HandleMenuMsg2Fn =
                    unsafe extern "system" fn(*mut c_void, u32, usize, isize, *mut isize) -> i32;
                let f: HandleMenuMsg2Fn = unsafe { std::mem::transmute(*vtbl.add(7)) };
                let mut result: isize = 0;
                unsafe { f(ptr, msg, wparam, lparam, &mut result) };
                Some(result) // WM_MENUCHAR needs the returned value
            }
            2 => {
                type HandleMenuMsgFn =
                    unsafe extern "system" fn(*mut c_void, u32, usize, isize) -> i32;
                let f: HandleMenuMsgFn = unsafe { std::mem::transmute(*vtbl.add(6)) };
                unsafe { f(ptr, msg, wparam, lparam) };
                Some(0)
            }
            _ => None,
        }
    }

    /// Publishes the QI'd IContextMenu2/3 for the wndproc while alive;
    /// clears the statics and releases the pointer on drop.
    struct MenuMsgForwarder {
        /// Held only so the interface outlives the menu loop (released on drop).
        _iface: ComPtr,
    }
    impl MenuMsgForwarder {
        unsafe fn install(context_menu: &ComPtr) -> Option<Self> {
            type QiFn =
                unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> i32;
            let qi: QiFn = std::mem::transmute(*context_menu.vtbl());
            for (iid, ver) in [(&IID_ICONTEXT_MENU3, 3u8), (&IID_ICONTEXT_MENU2, 2u8)] {
                let mut ptr: *mut c_void = std::ptr::null_mut();
                if qi(context_menu.0, iid, &mut ptr) == 0 && !ptr.is_null() {
                    ACTIVE_MENU_PTR.store(ptr as isize, Ordering::Release);
                    ACTIVE_MENU_VER.store(ver, Ordering::Release);
                    return Some(Self { _iface: ComPtr(ptr) });
                }
            }
            None
        }
    }
    impl Drop for MenuMsgForwarder {
        fn drop(&mut self) {
            ACTIVE_MENU_PTR.store(0, Ordering::Release);
            ACTIVE_MENU_VER.store(0, Ordering::Release);
        }
    }

    /// Show the shell context menu for `path` at the cursor position.
    /// Returns Ok(Some(i)) when appended extra item `i` was picked,
    /// Ok(None) when a native verb ran or the menu was dismissed.
    pub unsafe fn show_menu(
        hwnd: isize,
        path: &str,
        extra_items: &[String],
    ) -> Result<Option<u32>, String> {
        let _com = ComGuard::init();

        // Path → absolute PIDL → parent IShellFolder + child PIDL
        let wide_path = wide(path);
        let mut pidl: *mut c_void = std::ptr::null_mut();
        if SHParseDisplayName(wide_path.as_ptr(), std::ptr::null_mut(), &mut pidl, 0, std::ptr::null_mut()) != 0
            || pidl.is_null()
        {
            return Err("SHParseDisplayName failed".into());
        }
        struct PidlFree(*mut c_void);
        impl Drop for PidlFree {
            fn drop(&mut self) {
                unsafe { CoTaskMemFree(self.0) };
            }
        }
        let _pidl_free = PidlFree(pidl);

        let mut folder_ptr: *mut c_void = std::ptr::null_mut();
        let mut pidl_child: *const c_void = std::ptr::null();
        if SHBindToParent(pidl, &IID_ISHELL_FOLDER, &mut folder_ptr, &mut pidl_child) != 0
            || folder_ptr.is_null()
        {
            return Err("SHBindToParent failed".into());
        }
        let folder = ComPtr(folder_ptr);

        // IShellFolder vtable slot 10: GetUIObjectOf
        type GetUIObjectOfFn = unsafe extern "system" fn(
            *mut c_void,
            isize,
            u32,
            *const *const c_void,
            *const Guid,
            *mut u32,
            *mut *mut c_void,
        ) -> i32;
        let get_ui_object: GetUIObjectOfFn = std::mem::transmute(*folder.vtbl().add(10));
        let mut menu_ptr: *mut c_void = std::ptr::null_mut();
        if get_ui_object(
            folder.0,
            hwnd,
            1,
            &pidl_child,
            &IID_ICONTEXT_MENU,
            std::ptr::null_mut(),
            &mut menu_ptr,
        ) != 0
            || menu_ptr.is_null()
        {
            return Err("GetUIObjectOf(IContextMenu) failed".into());
        }
        let context_menu = ComPtr(menu_ptr);

        let hmenu = CreatePopupMenu();
        if hmenu == 0 {
            return Err("CreatePopupMenu failed".into());
        }
        struct MenuFree(isize);
        impl Drop for MenuFree {
            fn drop(&mut self) {
                unsafe { DestroyMenu(self.0) };
            }
        }
        let _menu_free = MenuFree(hmenu);

        // IContextMenu vtable slot 3: QueryContextMenu
        type QueryContextMenuFn =
            unsafe extern "system" fn(*mut c_void, isize, u32, u32, u32, u32) -> i32;
        let query: QueryContextMenuFn = std::mem::transmute(*context_menu.vtbl().add(3));
        if query(context_menu.0, hmenu, 0, ID_FIRST, ID_LAST, CMF_NORMAL) < 0 {
            return Err("QueryContextMenu failed".into());
        }

        // DeskChan-specific entries after a separator
        if !extra_items.is_empty() {
            AppendMenuW(hmenu, MF_SEPARATOR, 0, std::ptr::null());
            for (i, label) in extra_items.iter().enumerate() {
                let text = wide(label);
                AppendMenuW(hmenu, MF_STRING, (ID_EXTRA_BASE + i as u32) as usize, text.as_ptr());
            }
        }

        // Forward menu messages to IContextMenu2/3 while the menu is open —
        // without this, "Send To" / "Open With" submenus stay empty.
        let _forwarder = MenuMsgForwarder::install(&context_menu);

        // Menus on a NOACTIVATE window need explicit foreground, or the menu
        // won't dismiss when clicking elsewhere (classic tray-menu fix).
        let mut pt = Point { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenuEx(
            hmenu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            hwnd,
            std::ptr::null_mut(),
        ) as u32;
        PostMessageW(hwnd, WM_NULL, 0, 0);

        if cmd == 0 {
            return Ok(None); // dismissed
        }
        // Only ids we actually appended count as extras — buggy shell
        // extensions have been seen straying beyond idCmdLast. Out-of-range
        // ids can't be dispatched by the composite IContextMenu either, so
        // don't hand them to InvokeCommand.
        if cmd >= ID_EXTRA_BASE {
            let idx = cmd - ID_EXTRA_BASE;
            return Ok(((idx as usize) < extra_items.len()).then_some(idx));
        }

        // Native verb picked — let the shell execute it.
        // IContextMenu vtable slot 4: InvokeCommand
        type InvokeCommandFn =
            unsafe extern "system" fn(*mut c_void, *const CmInvokeCommandInfo) -> i32;
        let invoke: InvokeCommandFn = std::mem::transmute(*context_menu.vtbl().add(4));
        let info = CmInvokeCommandInfo {
            cbSize: std::mem::size_of::<CmInvokeCommandInfo>() as u32,
            fMask: 0,
            hwnd,
            lpVerb: (cmd - ID_FIRST) as usize as *const u8, // MAKEINTRESOURCE
            lpParameters: std::ptr::null(),
            lpDirectory: std::ptr::null(),
            nShow: SW_SHOWNORMAL,
            dwHotKey: 0,
            hIcon: 0,
        };
        invoke(context_menu.0, &info);
        Ok(None)
    }
}
