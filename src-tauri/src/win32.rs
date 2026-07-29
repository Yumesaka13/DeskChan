//! Shared raw Win32 / COM FFI helpers.
//!
//! No external windows crate on purpose - see Cargo.toml: raw FFI avoids
//! version conflicts with Tauri's internal windows-core dependency. Every
//! declaration used by more than one module lives here; single-use externs
//! stay next to their call site.

use std::ffi::c_void;

/// NUL-terminated UTF-16 for W-suffixed Win32 APIs.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// Common user32 declarations shared across modules.
extern "system" {
    pub fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
    pub fn SetWindowLongW(hwnd: isize, index: i32, value: i32) -> i32;
    pub fn SetWindowPos(
        hwnd: isize,
        insert_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    pub fn GetWindow(hwnd: isize, cmd: u32) -> isize;
    pub fn FindWindowW(class: *const u16, name: *const u16) -> isize;
    pub fn FindWindowExW(parent: isize, child: isize, class: *const u16, name: *const u16)
        -> isize;
    pub fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    pub fn IsWindowVisible(hwnd: isize) -> i32;
}

extern "system" {
    fn CoInitializeEx(pv: *mut c_void, co_init: u32) -> i32;
    fn CoUninitialize();
}

const COINIT_APARTMENTTHREADED: u32 = 0x2;

/// Balances CoInitializeEx/CoUninitialize (shell APIs want COM ready on the
/// calling thread - Tauri command threads are not guaranteed to be).
/// S_OK / S_FALSE (>= 0) must be balanced; RPC_E_CHANGED_MODE must not.
pub struct ComGuard(bool);

impl ComGuard {
    pub fn init() -> Self {
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

/// Windows GUID layout, used for raw IID constants.
#[repr(C)]
pub struct Guid {
    pub d1: u32,
    pub d2: u16,
    pub d3: u16,
    pub d4: [u8; 8],
}

/// Releases a COM interface pointer on drop (vtable slot 2 = Release).
pub struct ComPtr(pub *mut c_void);

impl ComPtr {
    /// # Safety
    /// `self.0` must point to a live COM object.
    pub unsafe fn vtbl(&self) -> *const usize {
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
