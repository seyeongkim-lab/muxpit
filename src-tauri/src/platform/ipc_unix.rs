use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;

const EXISTING_SOCKET_PROBE_TIMEOUT: Duration = Duration::from_millis(500);

pub(super) fn server_loop(app: AppHandle) {
    let endpoint = super::paths::ipc_socket_endpoint();
    let socket_path = endpoint.path;
    if let Err(e) = prepare_socket_parent(&socket_path, endpoint.secure_parent) {
        log::error!("{e}");
        return;
    }

    match std::fs::symlink_metadata(&socket_path) {
        Ok(meta) if meta.file_type().is_socket() => {
            if existing_socket_is_live(&socket_path) {
                log::error!(
                    "IPC socket already has a live server: {}",
                    socket_path.display()
                );
                app.exit(0);
                return;
            }
            log::warn!("Removing stale IPC socket: {}", socket_path.display());
            let _ = std::fs::remove_file(&socket_path);
        }
        Ok(_) => {
            log::error!(
                "IPC path exists and is not a socket: {}",
                socket_path.display()
            );
            return;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::error!(
                "Failed to inspect IPC socket path {}: {e}",
                socket_path.display()
            );
            return;
        }
    }

    let listener = match UnixListener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            log::error!(
                "Failed to bind Unix socket at {}: {e}",
                socket_path.display()
            );
            return;
        }
    };
    let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app = app.clone();
                std::thread::spawn(move || {
                    use std::os::unix::io::{FromRawFd, IntoRawFd};
                    let fd = stream.into_raw_fd();
                    let file = unsafe { std::fs::File::from_raw_fd(fd) };
                    if let Err(e) = super::ipc::handle_client(file, &app) {
                        log::warn!("IPC client error: {e}");
                    }
                });
            }
            Err(e) => {
                log::error!("IPC accept error: {e}");
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    }
}

fn prepare_socket_parent(path: &Path, secure_parent: bool) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create IPC socket dir {}: {e}", parent.display()))?;

    if !secure_parent {
        return Ok(());
    }

    let meta = std::fs::symlink_metadata(parent)
        .map_err(|e| format!("Failed to inspect IPC socket dir {}: {e}", parent.display()))?;
    if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
        return Err(format!(
            "IPC socket parent is not a plain directory: {}",
            parent.display()
        ));
    }
    if meta.uid() != current_euid() {
        return Err(format!(
            "IPC socket parent {} is not owned by the current user",
            parent.display()
        ));
    }

    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to secure IPC socket dir {}: {e}", parent.display()))
}

fn current_euid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() }
}

fn existing_socket_is_live(path: &Path) -> bool {
    let Ok(mut stream) = UnixStream::connect(path) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(EXISTING_SOCKET_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(EXISTING_SOCKET_PROBE_TIMEOUT));

    if stream
        .write_all(b"{\"method\":\"ping\",\"params\":{}}\n")
        .is_err()
    {
        return false;
    }

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) | Err(_) => false,
        Ok(_) => ipc_ping_succeeded(&line),
    }
}

fn ipc_ping_succeeded(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("ok").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_ping_succeeded_accepts_ok_response() {
        assert!(ipc_ping_succeeded(r#"{"ok":true,"data":"pong"}"#));
    }

    #[test]
    fn ipc_ping_succeeded_rejects_error_or_invalid_response() {
        assert!(!ipc_ping_succeeded(r#"{"ok":false,"error":"busy"}"#));
        assert!(!ipc_ping_succeeded("not json"));
    }

    #[test]
    fn prepare_socket_parent_does_not_chmod_override_parent() {
        let parent =
            std::env::temp_dir().join(format!("wmux-override-parent-test-{}", std::process::id()));
        let socket = parent.join("wmux.sock");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();

        prepare_socket_parent(&socket, false).unwrap();

        let mode = std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn prepare_socket_parent_secures_managed_parent() {
        let parent =
            std::env::temp_dir().join(format!("wmux-managed-parent-test-{}", std::process::id()));
        let socket = parent.join("wmux.sock");

        prepare_socket_parent(&socket, true).unwrap();

        let mode = std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let _ = std::fs::remove_dir_all(&parent);
    }
}
