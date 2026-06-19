use std::env;
#[cfg(not(windows))]
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(not(windows))]
pub(crate) fn home_dir() -> Option<PathBuf> {
    non_empty_var("HOME").map(PathBuf::from)
}

#[cfg(windows)]
pub(crate) fn home_dir() -> Option<PathBuf> {
    windows_home_dir_from_values(
        non_empty_var("HOME"),
        non_empty_var("USERPROFILE"),
        non_empty_var("HOMEDRIVE"),
        non_empty_var("HOMEPATH"),
    )
}

fn non_empty_var(name: &str) -> Option<std::ffi::OsString> {
    env::var_os(name).filter(|value| !value.is_empty())
}

pub(crate) fn binary_on_path(name: &str) -> bool {
    let names = path_lookup_names(name);
    env::var_os("PATH")
        .map(|paths| {
            env::split_paths(&paths).any(|dir| names.iter().any(|name| dir.join(name).is_file()))
        })
        .unwrap_or(false)
}

fn path_lookup_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let path = Path::new(name);
        if path.extension().is_some() {
            return vec![name.to_string()];
        }
        let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let mut names = vec![name.to_string()];
        for ext in pathext.split(';') {
            let ext = ext.trim();
            if ext.is_empty() {
                continue;
            }
            names.push(format!("{name}{}", ext.to_ascii_lowercase()));
            names.push(format!("{name}{}", ext.to_ascii_uppercase()));
        }
        names.sort();
        names.dedup();
        names
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

pub(crate) fn replace_file(tmp: &Path, path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        return replace_file_windows(tmp, path);
    }
    #[cfg(not(windows))]
    fs::rename(tmp, path)
}

#[cfg(windows)]
fn replace_file_windows(tmp: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let tmp_w: Vec<u16> = tmp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let path_w: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    let ok = unsafe { MoveFileExW(tmp_w.as_ptr(), path_w.as_ptr(), flags) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn windows_home_dir_from_values(
    home: Option<std::ffi::OsString>,
    userprofile: Option<std::ffi::OsString>,
    homedrive: Option<std::ffi::OsString>,
    homepath: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if let Some(path) = userprofile
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Some(path);
    }
    if let (Some(drive), Some(path)) = (homedrive, homepath) {
        let joined = PathBuf::from(format!(
            "{}{}",
            drive.to_string_lossy(),
            path.to_string_lossy()
        ));
        if joined.is_absolute() {
            return Some(joined);
        }
    }
    home.map(PathBuf::from)
        .filter(|path| is_native_windows_home(path))
}

#[cfg(windows)]
fn is_native_windows_home(path: &Path) -> bool {
    use std::path::Component;
    matches!(path.components().next(), Some(Component::Prefix(_)))
}

pub(crate) fn hook_command(
    agent_name: &str,
    disabled_env: &str,
    current_exe: Option<&Path>,
) -> String {
    #[cfg(windows)]
    {
        windows_hook_command(agent_name, disabled_env, current_exe)
    }
    #[cfg(not(windows))]
    {
        unix_hook_command(agent_name, disabled_env, current_exe)
    }
}

#[cfg(any(not(windows), test))]
fn unix_hook_command(agent_name: &str, disabled_env: &str, current_exe: Option<&Path>) -> String {
    let current_exe = current_exe
        .map(|path| shell_single_quote(path.to_string_lossy().as_ref()))
        .unwrap_or_else(|| "\"\"".to_string());
    let marker = shell_single_quote(&format!("wmux-cli hooks {agent_name}"));

    format!(
        ": {marker}; wmux_cli=\"${{WMUX_BUNDLED_CLI_PATH:-}}\"; \
         if [ -z \"$wmux_cli\" ] || [ ! -x \"$wmux_cli\" ]; then wmux_cli={current_exe}; fi; \
         if [ -n \"${{WMUX_SURFACE_ID:-}}\" ] && [ \"${{{disabled_env}:-}}\" != \"1\" ] && [ -n \"$wmux_cli\" ] && [ -x \"$wmux_cli\" ]; then \
         \"$wmux_cli\" hooks {agent_name} stop || echo '{{}}'; else echo '{{}}'; fi",
    )
}

#[cfg(any(windows, test))]
fn windows_hook_command(
    agent_name: &str,
    disabled_env: &str,
    current_exe: Option<&Path>,
) -> String {
    let current_exe = current_exe
        .map(|path| powershell_single_quote(path.to_string_lossy().as_ref()))
        .unwrap_or_else(|| "''".to_string());
    let script = format!(
        "$wmuxCli=$env:WMUX_BUNDLED_CLI_PATH; \
         if ([string]::IsNullOrWhiteSpace($wmuxCli) -or -not (Test-Path -LiteralPath $wmuxCli -PathType Leaf)) {{ $wmuxCli={current_exe}; }}; \
         if (-not [string]::IsNullOrWhiteSpace($env:WMUX_SURFACE_ID) -and $env:{disabled_env} -ne '1' -and -not [string]::IsNullOrWhiteSpace($wmuxCli) -and (Test-Path -LiteralPath $wmuxCli -PathType Leaf)) {{ \
         & $wmuxCli hooks {agent_name} stop; if ($LASTEXITCODE -ne 0) {{ Write-Output '{{}}' }} \
         }} else {{ Write-Output '{{}}' }}"
    );

    format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command {}",
        windows_command_argument(&script)
    )
}

#[cfg(any(not(windows), test))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(any(windows, test))]
fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(any(windows, test))]
fn windows_command_argument(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn path_lookup_names_non_windows_is_exact() {
        assert_eq!(path_lookup_names("codex"), vec!["codex".to_string()]);
    }

    #[test]
    fn unix_hook_command_contains_posix_guards() {
        let command = unix_hook_command(
            "codex",
            "WMUX_CODEX_HOOKS_DISABLED",
            Some(Path::new("/tmp/wmux cli's/bin/wmux-cli")),
        );

        assert!(command.contains("WMUX_BUNDLED_CLI_PATH"));
        assert!(command.contains("WMUX_SURFACE_ID"));
        assert!(command.contains("${WMUX_CODEX_HOOKS_DISABLED:-}"));
        assert!(command.contains("hooks codex stop"));
        assert!(command.contains("'/tmp/wmux cli'\\''s/bin/wmux-cli'"));
    }

    #[test]
    fn windows_hook_command_uses_powershell_template() {
        let command = windows_hook_command(
            "claude",
            "WMUX_CLAUDE_HOOKS_DISABLED",
            Some(Path::new(r"C:\Program Files\wmux\wmux-cli.exe")),
        );

        assert!(command.starts_with("powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "));
        assert!(command.contains("$env:WMUX_CLAUDE_HOOKS_DISABLED -ne '1'"));
        assert!(command.contains("hooks claude stop"));
        assert!(command.contains(r"C:\Program Files\wmux\wmux-cli.exe"));
    }
}
