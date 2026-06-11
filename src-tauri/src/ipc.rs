use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
const PIPE_NAME: &str = r"\\.\pipe\wmux";

#[cfg(unix)]
const SOCKET_PATH: &str = "/tmp/wmux.sock";

#[derive(Debug, Deserialize)]
struct IpcRequest {
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct IpcResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn start_ipc_server(app: AppHandle) {
    std::thread::spawn(move || {
        ipc_server_loop(app);
    });
}

#[cfg(windows)]
fn ipc_server_loop(app: AppHandle) {
    loop {
        match accept_client_windows() {
            Ok(stream) => {
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(e) = handle_client(stream, &app) {
                        log::warn!("IPC client error: {e}");
                    }
                });
            }
            Err(e) => {
                log::error!("IPC pipe error: {e}");
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    }
}

#[cfg(windows)]
fn accept_client_windows() -> Result<std::fs::File, String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::*;

    extern "system" {
        fn ConnectNamedPipe(hNamedPipe: *mut std::ffi::c_void, lpOverlapped: *mut std::ffi::c_void) -> i32;
    }

    let pipe_name: Vec<u8> = PIPE_NAME.bytes().chain(std::iter::once(0)).collect();

    unsafe {
        let handle = CreateNamedPipeA(
            pipe_name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            4096,
            4096,
            0,
            std::ptr::null(),
        );

        if handle == INVALID_HANDLE_VALUE {
            return Err("CreateNamedPipe failed".to_string());
        }

        let result = ConnectNamedPipe(handle, std::ptr::null_mut());
        if result == 0 {
            let err = windows_sys::Win32::Foundation::GetLastError();
            // ERROR_PIPE_CONNECTED (535) is OK
            if err != 535 {
                return Err(format!("ConnectNamedPipe failed: error {err}"));
            }
        }

        Ok(std::fs::File::from_raw_handle(handle as *mut std::ffi::c_void))
    }
}

#[cfg(unix)]
fn ipc_server_loop(app: AppHandle) {
    use std::os::unix::net::UnixListener;

    // Remove stale socket file
    let _ = std::fs::remove_file(SOCKET_PATH);

    let listener = match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to bind Unix socket at {SOCKET_PATH}: {e}");
            return;
        }
    };

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app = app.clone();
                std::thread::spawn(move || {
                    use std::os::unix::io::IntoRawFd;
                    use std::os::unix::io::FromRawFd;
                    let fd = stream.into_raw_fd();
                    let file = unsafe { std::fs::File::from_raw_fd(fd) };
                    if let Err(e) = handle_client(file, &app) {
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

fn handle_client(mut stream: std::fs::File, app: &AppHandle) -> Result<(), String> {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|e| format!("Clone error: {e}"))?,
    );

    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("Read error: {e}")),
        }

        if line.trim().is_empty() {
            continue;
        }

        let req: IpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = IpcResponse {
                    ok: false,
                    data: None,
                    error: Some(format!("Parse error: {e}")),
                };
                let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap());
                continue;
            }
        };

        let resp = handle_request(&req, app);
        let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap());
    }

    Ok(())
}

fn handle_request(req: &IpcRequest, app: &AppHandle) -> IpcResponse {
    match req.method.as_str() {
        "ping" => IpcResponse {
            ok: true,
            data: Some(serde_json::json!("pong")),
            error: None,
        },
        "notify" => {
            let title = req
                .params
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("wmux");
            let body = req
                .params
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let _ = app.emit(
                "wmux-notify",
                serde_json::json!({
                    "title": title,
                    "body": body,
                }),
            );

            IpcResponse {
                ok: true,
                data: None,
                error: None,
            }
        }
        "list-workspaces" => {
            use tauri::Manager;
            let registry = app.state::<crate::WorkspaceRegistry>();
            let list = registry.0.lock().unwrap().clone();
            match serde_json::to_value(&list) {
                Ok(v) => IpcResponse {
                    ok: true,
                    data: Some(v),
                    error: None,
                },
                Err(e) => IpcResponse {
                    ok: false,
                    data: None,
                    error: Some(format!("serialize error: {e}")),
                },
            }
        }
        _ => IpcResponse {
            ok: false,
            data: None,
            error: Some(format!("Unknown method: {}", req.method)),
        },
    }
}
