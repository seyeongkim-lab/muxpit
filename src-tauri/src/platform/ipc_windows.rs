use tauri::AppHandle;

pub(super) fn server_loop(app: AppHandle) {
    let pipe_name = super::paths::ipc_pipe_name();
    let _single_instance = match SingleInstanceGuard::acquire(&pipe_name) {
        Ok(guard) => guard,
        Err(SingleInstanceError::AlreadyRunning) => {
            log::error!("wmux IPC server already running for pipe {pipe_name}");
            // Another wmux process owns the CLI/hook IPC pipe. Keep this GUI
            // instance alive; otherwise a stale hidden process can make every
            // new launch appear and immediately close.
            return;
        }
        Err(SingleInstanceError::Other(e)) => {
            log::error!("Failed to acquire wmux IPC singleton: {e}");
            return;
        }
    };

    loop {
        match accept_client(&pipe_name) {
            Ok(stream) => {
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(e) = super::ipc::handle_client(stream, &app) {
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

enum SingleInstanceError {
    AlreadyRunning,
    Other(String),
}

struct SingleInstanceGuard(windows_sys::Win32::Foundation::HANDLE);

impl SingleInstanceGuard {
    fn acquire(pipe_name: &str) -> Result<Self, SingleInstanceError> {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;

        let mutex_name = wmux_platform::paths::windows_mutex_name_from_pipe(pipe_name);
        let mutex_name = wide_null(&mutex_name);
        let handle = unsafe { CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr()) };
        if handle.is_null() {
            return Err(SingleInstanceError::Other("CreateMutex failed".to_string()));
        }
        let err = unsafe { GetLastError() };
        if err == ERROR_ALREADY_EXISTS {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Err(SingleInstanceError::AlreadyRunning);
        }
        Ok(Self(handle))
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn accept_client(pipe_name: &str) -> Result<std::fs::File, String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::*;

    let pipe_name = wide_null(pipe_name);

    unsafe {
        let handle = CreateNamedPipeW(
            pipe_name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
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
            if err != ERROR_PIPE_CONNECTED {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                return Err(format!("ConnectNamedPipe failed: error {err}"));
            }
        }

        Ok(std::fs::File::from_raw_handle(
            handle as *mut std::ffi::c_void,
        ))
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
