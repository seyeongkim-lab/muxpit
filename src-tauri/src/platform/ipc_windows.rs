use tauri::AppHandle;

const PIPE_NAME: &str = r"\\.\pipe\wmux";

pub(super) fn server_loop(app: AppHandle) {
    loop {
        match accept_client() {
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

fn accept_client() -> Result<std::fs::File, String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::*;

    extern "system" {
        fn ConnectNamedPipe(
            hNamedPipe: *mut std::ffi::c_void,
            lpOverlapped: *mut std::ffi::c_void,
        ) -> i32;
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
            if err != 535 {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                return Err(format!("ConnectNamedPipe failed: error {err}"));
            }
        }

        Ok(std::fs::File::from_raw_handle(
            handle as *mut std::ffi::c_void,
        ))
    }
}
