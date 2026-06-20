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

    match std::env::var("WMUX_BUNDLED_CLI_PATH") {
        Ok(cli_path) if !cli_path.is_empty() => {
            cmd.env("WMUX_BUNDLED_CLI_PATH", cli_path);
        }
        _ => {
            if let Some(cli_path) = super::cli::bundled_cli_path() {
                cmd.env("WMUX_BUNDLED_CLI_PATH", cli_path);
            }
        }
    }
}

pub fn default_shell_command(enable_cwd_reporting: bool) -> CommandBuilder {
    #[cfg(windows)]
    {
        return default_windows_shell_command(enable_cwd_reporting);
    }

    #[cfg(not(windows))]
    {
        let _ = enable_cwd_reporting;
        CommandBuilder::new_default_prog()
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsShellKind {
    PowerShell,
    Cmd,
}

#[cfg(windows)]
fn default_windows_shell_command(enable_cwd_reporting: bool) -> CommandBuilder {
    let (program, kind) = default_windows_shell();
    let mut cmd = CommandBuilder::new(program);
    if enable_cwd_reporting {
        apply_windows_cwd_reporting_hook(&mut cmd, kind);
    }
    cmd
}

#[cfg(windows)]
fn default_windows_shell() -> (std::ffi::OsString, WindowsShellKind) {
    for name in &["pwsh.exe", "powershell.exe"] {
        let mut cmd = silent_command("where");
        cmd.arg(name);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = path.lines().next() {
                    return (
                        std::ffi::OsString::from(first_line.trim()),
                        WindowsShellKind::PowerShell,
                    );
                }
            }
        }
    }
    (std::ffi::OsString::from("cmd.exe"), WindowsShellKind::Cmd)
}

#[cfg(windows)]
fn apply_windows_cwd_reporting_hook(cmd: &mut CommandBuilder, kind: WindowsShellKind) {
    match kind {
        WindowsShellKind::PowerShell => {
            cmd.args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                POWERSHELL_CWD_REPORTING_HOOK,
            ]);
        }
        WindowsShellKind::Cmd => {
            cmd.args(["/K", "prompt $E]7;file://localhost/$P$E\\$P$G"]);
        }
    }
}

#[cfg(windows)]
const POWERSHELL_CWD_REPORTING_HOOK: &str = r#"
if (-not $global:__wmuxCwdHooked) {
  $global:__wmuxCwdHooked = $true
  $global:__wmuxOriginalPrompt = (Get-Command prompt -CommandType Function).ScriptBlock
  function global:prompt {
    try {
      $loc = Get-Location
      if ($loc.Provider.Name -eq 'FileSystem') {
        $uri = [System.Uri]::new($loc.ProviderPath).AbsoluteUri
        [Console]::Write("$([char]27)]7;$uri$([char]7)")
      }
    } catch {}
    & $global:__wmuxOriginalPrompt
  }
}
"#;
