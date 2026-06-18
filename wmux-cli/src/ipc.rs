use std::io::{Read, Write};

#[cfg(windows)]
use std::fs::OpenOptions;

#[cfg(windows)]
const PIPE_NAME: &str = r"\\.\pipe\wmux";

pub(crate) trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

#[cfg(windows)]
pub(crate) fn connect() -> std::io::Result<Box<dyn ReadWrite>> {
    let pipe = OpenOptions::new().read(true).write(true).open(PIPE_NAME)?;
    Ok(Box::new(pipe))
}

#[cfg(unix)]
pub(crate) fn connect() -> std::io::Result<Box<dyn ReadWrite>> {
    let stream = std::os::unix::net::UnixStream::connect(wmux_platform::paths::unix_socket_path())?;
    Ok(Box::new(stream))
}
