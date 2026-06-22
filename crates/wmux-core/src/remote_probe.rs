use crate::command::silent_command;
use crate::ssh_command::{quote_posix_shell_arg, SshCommand};
use std::collections::HashMap;
use std::process::Stdio;

pub fn check_remote_tmux(ssh: &SshCommand) -> Option<String> {
    let mut cmd = silent_command(&ssh.program);
    for opt in &ssh.options {
        cmd.arg(opt);
    }
    cmd.args([
        "-o",
        "ConnectTimeout=3",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]);
    cmd.arg(&ssh.target);
    cmd.arg("tmux -V 2>/dev/null");
    cmd.stderr(Stdio::null());

    match cmd.output() {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout
                .split_whitespace()
                .nth(1)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

pub fn check_remote_clis(
    ssh: &SshCommand,
    names: &[String],
) -> Result<HashMap<String, bool>, String> {
    let mut result: HashMap<String, bool> = names.iter().map(|n| (n.clone(), false)).collect();

    let safe_names: Vec<&str> = names
        .iter()
        .filter(|n| {
            !n.is_empty()
                && n.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .map(|n| n.as_str())
        .collect();
    if safe_names.is_empty() {
        return Ok(result);
    }

    let mut cmd = silent_command(&ssh.program);
    for opt in &ssh.options {
        cmd.arg(opt);
    }
    cmd.args([
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]);
    cmd.arg(&ssh.target);
    let remote = format!(
        "for n in {}; do command -v \"$n\" >/dev/null 2>&1 && echo \"$n\"; done",
        safe_names.join(" ")
    );
    cmd.arg(login_shell_remote_command(&remote));
    cmd.stderr(Stdio::null());

    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn ssh: {e}"))?;
    if output.status.code() == Some(255) {
        return Err("ssh probe connection failed".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let n = line.trim();
        if n.is_empty() {
            continue;
        }
        if let Some(v) = result.get_mut(n) {
            *v = true;
        }
    }
    Ok(result)
}

pub fn login_shell_remote_command(command: &str) -> String {
    let outer = format!(
        "shell=${{SHELL:-/bin/sh}}; \
         case \"$shell\" in sh|bash|zsh|ksh|dash|*/sh|*/bash|*/zsh|*/ksh|*/dash) wmux_shell=\"$shell\" ;; *) wmux_shell=/bin/sh ;; esac; \
         exec \"$wmux_shell\" -lc {}",
        quote_posix_shell_arg(command)
    );
    format!("/bin/sh -lc {}", quote_posix_shell_arg(&outer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_cli_probe_uses_configured_login_shell() {
        let command = login_shell_remote_command("command -v claude");

        assert!(command.starts_with("/bin/sh -lc "));
        assert!(command.contains("${SHELL:-/bin/sh}"));
        assert!(command.contains("case \"$shell\" in"));
        assert!(command.contains("*) wmux_shell=/bin/sh"));
        assert!(command.contains("command -v claude"));
        assert!(!command.contains("bash -lc"));
    }

    #[test]
    fn remote_cli_probe_quotes_inner_command() {
        let command = login_shell_remote_command("printf '%s\\n' ok");

        assert!(command.contains("'\\''%s\\n'\\''"));
    }
}
