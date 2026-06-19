use portable_pty::CommandBuilder;

#[cfg(windows)]
use super::command::silent_command;

pub fn apply_wmux_env(
    cmd: &mut CommandBuilder,
    workspace_id: Option<&str>,
    surface_id: Option<&str>,
) {
    if let Some(workspace_id) = workspace_id.filter(|value| !value.is_empty()) {
        cmd.env("WMUX_WORKSPACE_ID", workspace_id);
    }
    if let Some(surface_id) = surface_id.filter(|value| !value.is_empty()) {
        cmd.env("WMUX_SURFACE_ID", surface_id);
    }

    #[cfg(unix)]
    cmd.env("WMUX_SOCKET_PATH", super::paths::ipc_socket_path());
    #[cfg(windows)]
    cmd.env("WMUX_PIPE_NAME", super::paths::ipc_pipe_name());

    if let Ok(cli_path) = std::env::var("WMUX_BUNDLED_CLI_PATH") {
        if !cli_path.is_empty() {
            cmd.env("WMUX_BUNDLED_CLI_PATH", cli_path);
        }
    }
}

pub fn default_shell_command() -> CommandBuilder {
    if cfg!(windows) {
        CommandBuilder::new(default_windows_shell())
    } else {
        CommandBuilder::new_default_prog()
    }
}

#[cfg(windows)]
fn default_windows_shell() -> std::ffi::OsString {
    for name in &["pwsh.exe", "powershell.exe"] {
        let mut cmd = silent_command("where");
        cmd.arg(name);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = path.lines().next() {
                    return std::ffi::OsString::from(first_line.trim());
                }
            }
        }
    }
    std::ffi::OsString::from("cmd.exe")
}

#[cfg(not(windows))]
fn default_windows_shell() -> std::ffi::OsString {
    std::ffi::OsString::from("/bin/sh")
}
