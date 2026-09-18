//! Direct children of a process, for the ownership walk in `process.rs`.
//!
//! `proc_listchildpids` is exported by libproc but not bound by the `libproc` crate we use for
//! `pids_by_type`, so this module holds the one FFI declaration the ownership walk needs.

use std::ffi::c_void;
use std::io;
use std::mem::size_of;

use super::PlatformError;

unsafe extern "C" {
    fn proc_listchildpids(ppid: i32, buffer: *mut c_void, buffersize: i32) -> i32;
}

/// Live direct children of `parent`.
///
/// libproc grows no sizing oracle here: with a null buffer the return value is an internal byte
/// size (measured ~1073 for a single child), while a real call returns the number of PIDs written
/// — truncated to the slot count. A call that exactly fills the buffer is therefore re-asked with
/// a larger one, so a parent that forks widely cannot hide children behind the slot count.
pub(crate) fn child_process_ids(parent: u32) -> Result<Vec<u32>, PlatformError> {
    if parent > i32::MAX as u32 {
        return Err(PlatformError::Invalid(format!(
            "PID {parent} is out of range for child enumeration"
        )));
    }

    let mut capacity = 32_usize;
    while capacity <= 4096 {
        let mut buffer = vec![0_i32; capacity];
        let written = unsafe {
            proc_listchildpids(
                parent as i32,
                buffer.as_mut_ptr().cast(),
                size_of::<i32>().saturating_mul(capacity) as i32,
            )
        };
        if written < 0 {
            return Err(PlatformError::Io(io::Error::last_os_error()));
        }
        let count = written as usize;
        if count < capacity {
            buffer.truncate(count);
            return Ok(buffer
                .into_iter()
                .filter(|process_id| *process_id > 0)
                .map(|process_id| process_id as u32)
                .collect());
        }
        capacity *= 4;
    }

    Err(PlatformError::Invalid(format!(
        "children of PID {parent} exceeded the enumeration bound"
    )))
}
