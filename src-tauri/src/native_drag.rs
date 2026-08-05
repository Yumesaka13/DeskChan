//! Native Windows file drag source for DeskChan icons.
//!
//! WebView drag events cannot legally expose arbitrary local file paths, so
//! dragging icons out to other apps needs a small OLE IDataObject/IDropSource
//! that offers CF_HDROP, the same format Explorer-compatible targets consume.

use std::path::PathBuf;

#[cfg(target_os = "windows")]
mod win {
    use crate::win32::Guid;
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    const S_OK: i32 = 0;
    const E_NOTIMPL: i32 = 0x80004001u32 as i32;
    const E_NOINTERFACE: i32 = 0x80004002u32 as i32;
    const E_POINTER: i32 = 0x80004003u32 as i32;
    const DV_E_FORMATETC: i32 = 0x80040064u32 as i32;
    const OLE_E_ADVISENOTSUPPORTED: i32 = 0x80040003u32 as i32;
    const DATA_S_SAMEFORMATETC: i32 = 0x00040130;
    const DRAGDROP_S_DROP: i32 = 0x00040100;
    const DRAGDROP_S_CANCEL: i32 = 0x00040101;
    const DRAGDROP_S_USEDEFAULTCURSORS: i32 = 0x00040102;

    const CF_HDROP: u16 = 15;
    const DVASPECT_CONTENT: u32 = 1;
    const TYMED_HGLOBAL: u32 = 1;
    const DATADIR_GET: u32 = 1;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const GMEM_ZEROINIT: u32 = 0x0040;
    const MK_LBUTTON: u32 = 0x0001;
    const DROPEFFECT_COPY: u32 = 1;
    const DROPEFFECT_MOVE: u32 = 2;
    const DROPEFFECT_LINK: u32 = 4;

    const IID_IUNKNOWN: Guid = Guid {
        d1: 0x00000000,
        d2: 0x0000,
        d3: 0x0000,
        d4: [0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };
    const IID_IDATAOBJECT: Guid = Guid {
        d1: 0x0000010e,
        d2: 0x0000,
        d3: 0x0000,
        d4: [0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };
    const IID_IDROPSOURCE: Guid = Guid {
        d1: 0x00000121,
        d2: 0x0000,
        d3: 0x0000,
        d4: [0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
    };

    #[repr(C)]
    struct FormatEtc {
        cf_format: u16,
        ptd: *mut c_void,
        dw_aspect: u32,
        lindex: i32,
        tymed: u32,
    }

    #[repr(C)]
    struct StgMedium {
        tymed: u32,
        data: isize,
        p_unk_for_release: *mut c_void,
    }

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        x: i32,
        y: i32,
        f_nc: i32,
        f_wide: i32,
    }

    #[repr(C)]
    struct DataObject {
        vtbl: *const DataObjectVtbl,
        refs: AtomicU32,
        paths: Vec<String>,
    }

    #[repr(C)]
    struct DropSource {
        vtbl: *const DropSourceVtbl,
        refs: AtomicU32,
    }

    #[repr(C)]
    struct DataObjectVtbl {
        query_interface:
            unsafe extern "system" fn(*mut DataObject, *const Guid, *mut *mut c_void) -> i32,
        add_ref: unsafe extern "system" fn(*mut DataObject) -> u32,
        release: unsafe extern "system" fn(*mut DataObject) -> u32,
        get_data:
            unsafe extern "system" fn(*mut DataObject, *const FormatEtc, *mut StgMedium) -> i32,
        get_data_here:
            unsafe extern "system" fn(*mut DataObject, *const FormatEtc, *mut StgMedium) -> i32,
        query_get_data: unsafe extern "system" fn(*mut DataObject, *const FormatEtc) -> i32,
        get_canonical_format_etc:
            unsafe extern "system" fn(*mut DataObject, *const FormatEtc, *mut FormatEtc) -> i32,
        set_data: unsafe extern "system" fn(
            *mut DataObject,
            *const FormatEtc,
            *const StgMedium,
            i32,
        ) -> i32,
        enum_format_etc: unsafe extern "system" fn(*mut DataObject, u32, *mut *mut c_void) -> i32,
        d_advise: unsafe extern "system" fn(
            *mut DataObject,
            *const FormatEtc,
            u32,
            *mut c_void,
            *mut u32,
        ) -> i32,
        d_unadvise: unsafe extern "system" fn(*mut DataObject, u32) -> i32,
        enum_d_advise: unsafe extern "system" fn(*mut DataObject, *mut *mut c_void) -> i32,
    }

    #[repr(C)]
    struct DropSourceVtbl {
        query_interface:
            unsafe extern "system" fn(*mut DropSource, *const Guid, *mut *mut c_void) -> i32,
        add_ref: unsafe extern "system" fn(*mut DropSource) -> u32,
        release: unsafe extern "system" fn(*mut DropSource) -> u32,
        query_continue_drag: unsafe extern "system" fn(*mut DropSource, i32, u32) -> i32,
        give_feedback: unsafe extern "system" fn(*mut DropSource, u32) -> i32,
    }

    #[link(name = "ole32")]
    extern "system" {
        fn OleInitialize(reserved: *mut c_void) -> i32;
        fn OleUninitialize();
        fn DoDragDrop(
            data_object: *mut c_void,
            drop_source: *mut c_void,
            ok_effects: u32,
            effect: *mut u32,
        ) -> i32;
    }

    extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> isize;
        fn GlobalLock(memory: isize) -> *mut c_void;
        fn GlobalUnlock(memory: isize) -> i32;
        fn GlobalFree(memory: isize) -> isize;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHCreateStdEnumFmtEtc(
            format_count: u32,
            formats: *const FormatEtc,
            enum_format: *mut *mut c_void,
        ) -> i32;
    }

    struct OleGuard(bool);

    impl OleGuard {
        fn init() -> Result<Self, String> {
            let hr = unsafe { OleInitialize(std::ptr::null_mut()) };
            if hr >= 0 {
                Ok(Self(true))
            } else {
                Err(format!("OleInitialize failed: 0x{:08x}", hr as u32))
            }
        }
    }

    impl Drop for OleGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { OleUninitialize() };
            }
        }
    }

    fn guid_eq(left: &Guid, right: &Guid) -> bool {
        left.d1 == right.d1 && left.d2 == right.d2 && left.d3 == right.d3 && left.d4 == right.d4
    }

    fn format_ok(format: &FormatEtc) -> bool {
        format.cf_format == CF_HDROP
            && format.dw_aspect == DVASPECT_CONTENT
            && format.tymed & TYMED_HGLOBAL != 0
    }

    unsafe fn make_hdrop(paths: &[String]) -> Result<isize, i32> {
        let mut names = Vec::new();
        for path in paths {
            names.extend(path.encode_utf16());
            names.push(0);
        }
        names.push(0);
        let bytes = std::mem::size_of::<DropFiles>() + names.len() * std::mem::size_of::<u16>();
        let memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
        if memory == 0 {
            return Err(E_POINTER);
        }
        let ptr = GlobalLock(memory) as *mut u8;
        if ptr.is_null() {
            GlobalFree(memory);
            return Err(E_POINTER);
        }
        (ptr as *mut DropFiles).write(DropFiles {
            p_files: std::mem::size_of::<DropFiles>() as u32,
            x: 0,
            y: 0,
            f_nc: 0,
            f_wide: 1,
        });
        std::ptr::copy_nonoverlapping(
            names.as_ptr() as *const u8,
            ptr.add(std::mem::size_of::<DropFiles>()),
            names.len() * std::mem::size_of::<u16>(),
        );
        GlobalUnlock(memory);
        Ok(memory)
    }

    unsafe extern "system" fn data_query_interface(
        this: *mut DataObject,
        iid: *const Guid,
        out: *mut *mut c_void,
    ) -> i32 {
        if out.is_null() {
            return E_POINTER;
        }
        *out = std::ptr::null_mut();
        if iid.is_null() {
            return E_NOINTERFACE;
        }
        if guid_eq(&*iid, &IID_IUNKNOWN) || guid_eq(&*iid, &IID_IDATAOBJECT) {
            data_add_ref(this);
            *out = this.cast();
            S_OK
        } else {
            E_NOINTERFACE
        }
    }

    unsafe extern "system" fn data_add_ref(this: *mut DataObject) -> u32 {
        (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
    }

    unsafe extern "system" fn data_release(this: *mut DataObject) -> u32 {
        let refs = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
        if refs == 0 {
            std::sync::atomic::fence(Ordering::Acquire);
            drop(Box::from_raw(this));
        }
        refs
    }

    unsafe extern "system" fn data_get_data(
        this: *mut DataObject,
        format: *const FormatEtc,
        medium: *mut StgMedium,
    ) -> i32 {
        if format.is_null() || medium.is_null() {
            return E_POINTER;
        }
        if !format_ok(&*format) {
            return DV_E_FORMATETC;
        }
        match make_hdrop(&(*this).paths) {
            Ok(memory) => {
                (*medium).tymed = TYMED_HGLOBAL;
                (*medium).data = memory;
                (*medium).p_unk_for_release = std::ptr::null_mut();
                S_OK
            }
            Err(hr) => hr,
        }
    }

    unsafe extern "system" fn data_get_data_here(
        _this: *mut DataObject,
        _format: *const FormatEtc,
        _medium: *mut StgMedium,
    ) -> i32 {
        DV_E_FORMATETC
    }

    unsafe extern "system" fn data_query_get_data(
        _this: *mut DataObject,
        format: *const FormatEtc,
    ) -> i32 {
        if format.is_null() {
            return E_POINTER;
        }
        if format_ok(&*format) {
            S_OK
        } else {
            DV_E_FORMATETC
        }
    }

    unsafe extern "system" fn data_get_canonical_format_etc(
        _this: *mut DataObject,
        _input: *const FormatEtc,
        output: *mut FormatEtc,
    ) -> i32 {
        if !output.is_null() {
            (*output).ptd = std::ptr::null_mut();
        }
        DATA_S_SAMEFORMATETC
    }

    unsafe extern "system" fn data_set_data(
        _this: *mut DataObject,
        _format: *const FormatEtc,
        _medium: *const StgMedium,
        _release: i32,
    ) -> i32 {
        E_NOTIMPL
    }

    unsafe extern "system" fn data_enum_format_etc(
        _this: *mut DataObject,
        direction: u32,
        out: *mut *mut c_void,
    ) -> i32 {
        if out.is_null() {
            return E_POINTER;
        }
        *out = std::ptr::null_mut();
        if direction != DATADIR_GET {
            return DV_E_FORMATETC;
        }
        let format = FormatEtc {
            cf_format: CF_HDROP,
            ptd: std::ptr::null_mut(),
            dw_aspect: DVASPECT_CONTENT,
            lindex: -1,
            tymed: TYMED_HGLOBAL,
        };
        SHCreateStdEnumFmtEtc(1, &format, out)
    }

    unsafe extern "system" fn data_d_advise(
        _this: *mut DataObject,
        _format: *const FormatEtc,
        _flags: u32,
        _sink: *mut c_void,
        connection: *mut u32,
    ) -> i32 {
        if !connection.is_null() {
            *connection = 0;
        }
        OLE_E_ADVISENOTSUPPORTED
    }

    unsafe extern "system" fn data_d_unadvise(_this: *mut DataObject, _connection: u32) -> i32 {
        OLE_E_ADVISENOTSUPPORTED
    }

    unsafe extern "system" fn data_enum_d_advise(
        _this: *mut DataObject,
        out: *mut *mut c_void,
    ) -> i32 {
        if !out.is_null() {
            *out = std::ptr::null_mut();
        }
        OLE_E_ADVISENOTSUPPORTED
    }

    unsafe extern "system" fn source_query_interface(
        this: *mut DropSource,
        iid: *const Guid,
        out: *mut *mut c_void,
    ) -> i32 {
        if out.is_null() {
            return E_POINTER;
        }
        *out = std::ptr::null_mut();
        if iid.is_null() {
            return E_NOINTERFACE;
        }
        if guid_eq(&*iid, &IID_IUNKNOWN) || guid_eq(&*iid, &IID_IDROPSOURCE) {
            source_add_ref(this);
            *out = this.cast();
            S_OK
        } else {
            E_NOINTERFACE
        }
    }

    unsafe extern "system" fn source_add_ref(this: *mut DropSource) -> u32 {
        (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
    }

    unsafe extern "system" fn source_release(this: *mut DropSource) -> u32 {
        let refs = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
        if refs == 0 {
            std::sync::atomic::fence(Ordering::Acquire);
            drop(Box::from_raw(this));
        }
        refs
    }

    unsafe extern "system" fn source_query_continue_drag(
        _this: *mut DropSource,
        escape_pressed: i32,
        key_state: u32,
    ) -> i32 {
        if escape_pressed != 0 {
            DRAGDROP_S_CANCEL
        } else if key_state & MK_LBUTTON == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    unsafe extern "system" fn source_give_feedback(_this: *mut DropSource, _effect: u32) -> i32 {
        DRAGDROP_S_USEDEFAULTCURSORS
    }

    static DATA_OBJECT_VTBL: DataObjectVtbl = DataObjectVtbl {
        query_interface: data_query_interface,
        add_ref: data_add_ref,
        release: data_release,
        get_data: data_get_data,
        get_data_here: data_get_data_here,
        query_get_data: data_query_get_data,
        get_canonical_format_etc: data_get_canonical_format_etc,
        set_data: data_set_data,
        enum_format_etc: data_enum_format_etc,
        d_advise: data_d_advise,
        d_unadvise: data_d_unadvise,
        enum_d_advise: data_enum_d_advise,
    };

    static DROP_SOURCE_VTBL: DropSourceVtbl = DropSourceVtbl {
        query_interface: source_query_interface,
        add_ref: source_add_ref,
        release: source_release,
        query_continue_drag: source_query_continue_drag,
        give_feedback: source_give_feedback,
    };

    pub fn drag_files(paths: Vec<PathBuf>) -> Result<u32, String> {
        if paths.is_empty() {
            return Err("no files to drag".into());
        }
        let paths = paths
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = unsafe { do_drag_files(paths) };
            let _ = tx.send(result);
        });
        rx.recv().map_err(|e| e.to_string())?
    }

    unsafe fn do_drag_files(paths: Vec<String>) -> Result<u32, String> {
        let _ole = OleGuard::init()?;
        let data = Box::into_raw(Box::new(DataObject {
            vtbl: &DATA_OBJECT_VTBL,
            refs: AtomicU32::new(1),
            paths,
        }));
        let source = Box::into_raw(Box::new(DropSource {
            vtbl: &DROP_SOURCE_VTBL,
            refs: AtomicU32::new(1),
        }));
        let mut effect = 0;
        let hr = DoDragDrop(
            data.cast(),
            source.cast(),
            DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK,
            &mut effect,
        );
        data_release(data);
        source_release(source);
        if hr >= 0 {
            Ok(effect)
        } else {
            Err(format!("DoDragDrop failed: 0x{:08x}", hr as u32))
        }
    }
}

pub fn drag_files(paths: Vec<PathBuf>) -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        win::drag_files(paths)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = paths;
        Err("native file drag is only supported on Windows".into())
    }
}
