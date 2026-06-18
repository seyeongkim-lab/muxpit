#[cfg(unix)]
pub fn ipc_socket_path() -> std::path::PathBuf {
    wmux_platform::paths::unix_socket_path()
}
