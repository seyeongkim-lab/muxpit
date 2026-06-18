use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from).or_else(|| {
        #[cfg(windows)]
        {
            env::var_os("USERPROFILE").map(PathBuf::from)
        }
        #[cfg(not(windows))]
        {
            None
        }
    })
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
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    fs::rename(tmp, path)
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

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

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
