#[cfg(unix)]
pub fn ipc_socket_endpoint() -> wmux_platform::paths::UnixSocketEndpoint {
    wmux_platform::paths::unix_socket_endpoint()
}

#[cfg(unix)]
pub fn ipc_socket_path() -> std::path::PathBuf {
    ipc_socket_endpoint().path
}

#[cfg(windows)]
pub fn ipc_pipe_name() -> String {
    wmux_platform::paths::windows_pipe_name()
}
