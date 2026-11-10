use std::cell::Cell;
use std::path::PathBuf;

#[cfg(windows)]
use windows::core::{implement, HRESULT};
#[cfg(windows)]
use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, E_NOTIMPL};
#[cfg(windows)]
use windows::Win32::System::Com::{IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl, IEnumSTATDATA, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL};
#[cfg(windows)]
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT, GLOBAL_ALLOC_FLAGS};
#[cfg(windows)]
use windows::Win32::System::Ole::{DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE};
#[cfg(windows)]
use windows::Win32::System::SystemServices::{MODIFIERKEYS_FLAGS, MK_LBUTTON};

pub fn start(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Nothing selected.".into());
    }
    let mut files = Vec::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.starts_with("sftp:") {
            return Err("Copy the file to this computer before dragging it out.".into());
        }
        let target = if trimmed.starts_with("zip:") {
            crate::zipnav::export_temp(raw)?
        } else if trimmed.starts_with("gz:") {
            crate::gzipnav::export_temp(raw)?
        } else {
            trimmed.to_string()
        };
        let path = PathBuf::from(&target);
        if !path.exists() {
            return Err("Can't find that item.".into());
        }
        files.push(target);
    }
    #[cfg(windows)]
    {
        drag_files(&files)
    }
    #[cfg(not(windows))]
    {
        let _ = files;
        Err("Dragging out of FilePad works on Windows.".into())
    }
}

#[cfg(windows)]
fn drag_files(paths: &[String]) -> Result<(), String> {
    unsafe {
        let _ = OleInitialize(None);
        let data: IDataObject = FileData { paths: paths.to_vec() }.into();
        let source: IDropSource = FileSource.into();
        let mut effect = DROPEFFECT::default();
        let result = DoDragDrop(&data, &source, DROPEFFECT(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0), &mut effect);
        if result == DRAGDROP_S_DROP || result == DRAGDROP_S_CANCEL || result.0 == 0 {
            return Ok(());
        }
        Err("The drag was cancelled.".into())
    }
}

#[cfg(windows)]
#[implement(IDataObject)]
struct FileData {
    paths: Vec<String>,
}

#[cfg(windows)]
impl IDataObject_Impl for FileData_Impl {
    fn GetData(&self, format: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        if !format_ok(format) {
            return Err(DV_E_FORMATETC.into());
        }
        let bytes = hdrop_bytes(&self.this.paths);
        unsafe {
            let flags = GLOBAL_ALLOC_FLAGS(GMEM_MOVEABLE.0 | GMEM_ZEROINIT.0);
            let handle = GlobalAlloc(flags, bytes.len()).map_err(|_| DV_E_FORMATETC)?;
            let locked = GlobalLock(handle);
            if locked.is_null() {
                return Err(DV_E_FORMATETC.into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), locked as *mut u8, bytes.len());
            let _ = GlobalUnlock(handle);
            Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: handle },
                pUnkForRelease: std::mem::ManuallyDrop::new(None),
            })
        }
    }

    fn GetDataHere(&self, _format: *const FORMATETC, _medium: *mut STGMEDIUM) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        if format_ok(format) { HRESULT(0) } else { DV_E_FORMATETC }
    }

    fn GetCanonicalFormatEtc(&self, _input: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        if !output.is_null() {
            unsafe { *output = hdrop_format(); }
        }
        HRESULT(0x00040130)
    }

    fn SetData(&self, _format: *const FORMATETC, _medium: *const STGMEDIUM, _release: windows::core::BOOL) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, direction: u32) -> windows::core::Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        Ok(FormatList { index: Cell::new(0) }.into())
    }

    fn DAdvise(&self, _format: *const FORMATETC, _advf: u32, _sink: windows::core::Ref<'_, IAdviseSink>) -> windows::core::Result<u32> {
        Err(E_NOTIMPL.into())
    }

    fn DUnadvise(&self, _connection: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(E_NOTIMPL.into())
    }
}

#[cfg(windows)]
#[implement(IDropSource)]
struct FileSource;

#[cfg(windows)]
impl IDropSource_Impl for FileSource_Impl {
    fn QueryContinueDrag(&self, escape: windows::core::BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() {
            return DRAGDROP_S_CANCEL;
        }
        if keys.0 & MK_LBUTTON.0 == 0 {
            return DRAGDROP_S_DROP;
        }
        HRESULT(0)
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

#[cfg(windows)]
#[implement(IEnumFORMATETC)]
struct FormatList {
    index: Cell<u32>,
}

#[cfg(windows)]
impl IEnumFORMATETC_Impl for FormatList_Impl {
    fn Next(&self, count: u32, out: *mut FORMATETC, fetched: *mut u32) -> HRESULT {
        unsafe {
            if !fetched.is_null() {
                *fetched = 0;
            }
            if count == 0 || out.is_null() {
                return HRESULT(0);
            }
            if self.this.index.get() > 0 {
                return HRESULT(1);
            }
            *out = hdrop_format();
            self.this.index.set(1);
            if !fetched.is_null() {
                *fetched = 1;
            }
            HRESULT(0)
        }
    }

    fn Skip(&self, count: u32) -> windows::core::Result<()> {
        self.this.index.set(self.this.index.get().saturating_add(count));
        Ok(())
    }

    fn Reset(&self) -> windows::core::Result<()> {
        self.this.index.set(0);
        Ok(())
    }

    fn Clone(&self) -> windows::core::Result<IEnumFORMATETC> {
        Ok(FormatList { index: Cell::new(self.this.index.get()) }.into())
    }
}

#[cfg(windows)]
fn format_ok(format: *const FORMATETC) -> bool {
    if format.is_null() {
        return false;
    }
    let format = unsafe { &*format };
    let aspect = format.dwAspect == 0 || format.dwAspect == DVASPECT_CONTENT.0;
    format.cfFormat == CF_HDROP.0 && aspect && (format.tymed & (TYMED_HGLOBAL.0 as u32)) != 0
}

#[cfg(windows)]
fn hdrop_format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

#[cfg(windows)]
fn hdrop_bytes(paths: &[String]) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide = Vec::<u16>::new();
    for path in paths {
        wide.extend(std::ffi::OsStr::new(path).encode_wide());
        wide.push(0);
    }
    wide.push(0);
    #[repr(C)]
    struct Header {
        offset: u32,
        x: i32,
        y: i32,
        non_client: i32,
        wide: i32,
    }
    let header = Header { offset: 20, x: 0, y: 0, non_client: 0, wide: 1 };
    let mut bytes = Vec::with_capacity(20 + wide.len() * 2);
    bytes.extend_from_slice(unsafe { std::slice::from_raw_parts((&raw const header).cast::<u8>(), 20) });
    bytes.extend_from_slice(unsafe { std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * 2) });
    bytes
}
