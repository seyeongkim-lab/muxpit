use std::io::{Read, Write};

#[cfg(windows)]
use std::fs::{File, OpenOptions};
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

#[cfg(windows)]
pub(crate) fn connect() -> std::io::Result<Box<dyn ReadWrite>> {
    Ok(Box::new(connect_windows_pipe()?))
}

#[cfg(windows)]
fn connect_windows_pipe() -> std::io::Result<File> {
    let pipe_name = wmux_platform::paths::windows_pipe_name();
    let deadline = Instant::now() + PIPE_CONNECT_TIMEOUT;

    loop {
        match open_windows_pipe(&pipe_name) {
            Ok(pipe) => return Ok(pipe),
            Err(err) if is_pipe_busy(&err) => {
                let now = Instant::now();
                if now >= deadline {
                    return Err(err);
                }
                wait_named_pipe(&pipe_name, deadline.saturating_duration_since(now))?;
            }
            Err(err) => return Err(err),
        }
    }
}

#[cfg(windows)]
fn open_windows_pipe(pipe_name: &str) -> std::io::Result<File> {
    OpenOptions::new().read(true).write(true).open(pipe_name)
}

#[cfg(windows)]
fn is_pipe_busy(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_PIPE_BUSY as i32)
}

#[cfg(windows)]
fn wait_named_pipe(pipe_name: &str, timeout: Duration) -> std::io::Result<()> {
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

    let pipe_name = wide_null(pipe_name);
    let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
    let ok = unsafe { WaitNamedPipeW(pipe_name.as_ptr(), timeout_ms) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(unix)]
pub(crate) fn connect() -> std::io::Result<Box<dyn ReadWrite>> {
    let stream = std::os::unix::net::UnixStream::connect(wmux_platform::paths::unix_socket_path())?;
    Ok(Box::new(stream))
}
