use crate::command::silent_command;
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshCommand {
    pub program: String,
    pub options: Vec<String>,
    pub target: String,
    #[serde(default, rename = "ttyMode", skip_serializing_if = "Option::is_none")]
    pub tty_mode: Option<SshTtyMode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshTtyMode {
    Allocate,
    Force,
    Disable,
}

pub fn resolve_ssh_command(
    ssh_command: Option<&str>,
    ssh_connection: Option<SshCommand>,
) -> Option<SshCommand> {
    ssh_connection.or_else(|| ssh_command.and_then(parse_ssh_command))
}

pub fn split_command_line(input: &str) -> Vec<String> {
    split_command_line_for_platform(input, cfg!(windows))
}

pub fn split_command_line_for_platform(input: &str, windows: bool) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !in_double => {
                if windows && in_single && chars.peek() == Some(&'\'') {
                    current.push('\'');
                    chars.next();
                } else {
                    in_single = !in_single;
                }
            }
            '"' if !in_single => in_double = !in_double,
            '\\' if !in_single && !windows => {
                if let Some(&next) = chars.peek() {
                    let escapable = if in_double {
                        matches!(next, '"' | '\\' | '$' | '`')
                    } else {
                        matches!(next, ' ' | '\t' | '\'' | '"' | '\\')
                    };
                    if escapable {
                        current.push(next);
                        chars.next();
                    } else {
                        current.push(ch);
                    }
                } else {
                    current.push(ch);
                }
            }
            ' ' | '\t' if !in_single && !in_double => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        words.push(current);
    }

    words
}

pub fn parse_ssh_command(ssh_command: &str) -> Option<SshCommand> {
    let parts = split_command_line(ssh_command);
    if parts.is_empty() {
        return None;
    }

    let program = parts[0].clone();
    if !is_ssh_program(&program) {
        return None;
    }
    let mut options = Vec::new();
    let mut target = None;
    let mut tty_mode = None;
    let mut i = 1;

    while i < parts.len() {
        let part = &parts[i];
        if !part.starts_with('-') {
            target = Some(part.clone());
            break;
        }

        if let Some(mode) = execution_mode_option(part) {
            tty_mode = Some(mode);
            i += 1;
            continue;
        }
        if let Some((option, value)) = split_attached_option_value(part) {
            options.push(option.to_string());
            options.push(value.to_string());
            i += 1;
            continue;
        }
        options.push(part.clone());
        if option_takes_value(part) && i + 1 < parts.len() {
            i += 1;
            options.push(parts[i].clone());
        }
        i += 1;
    }

    target.map(|target| SshCommand {
        program,
        options,
        target,
        tty_mode,
    })
}

fn execution_mode_option(option: &str) -> Option<SshTtyMode> {
    match option {
        "-t" => Some(SshTtyMode::Allocate),
        "-tt" => Some(SshTtyMode::Force),
        "-T" => Some(SshTtyMode::Disable),
        _ => None,
    }
}

fn split_attached_option_value(option: &str) -> Option<(&str, &str)> {
    if option.len() <= 2 || !option.starts_with('-') || option.starts_with("--") {
        return None;
    }
    let short = &option[..2];
    option_takes_value(short).then_some((short, &option[2..]))
}

fn is_ssh_program(program: &str) -> bool {
    let normalized = program.replace('\\', "/").to_ascii_lowercase();
    normalized == "ssh" || normalized.ends_with("/ssh") || normalized.ends_with("/ssh.exe")
}

fn option_takes_value(option: &str) -> bool {
    matches!(
        option,
        "-B" | "-b"
            | "-c"
            | "-D"
            | "-E"
            | "-e"
            | "-F"
            | "-I"
            | "-i"
            | "-J"
            | "-L"
            | "-l"
            | "-m"
            | "-O"
            | "-o"
            | "-p"
            | "-Q"
            | "-R"
            | "-S"
            | "-W"
            | "-w"
    )
}

impl SshCommand {
    /// A sentinel that runs commands directly on the local host instead of over
    /// ssh. Used by wmux-server to operate on its own host (the browser
    /// runtime's "local"). Detected by an empty `program`.
    pub fn local() -> Self {
        SshCommand {
            program: String::new(),
            options: Vec::new(),
            target: String::new(),
            tty_mode: None,
        }
    }

    pub fn is_local(&self) -> bool {
        self.program.is_empty()
    }

    pub fn argv_with_extra_options(
        &self,
        extra_options: &[&str],
        remote_command: Option<&str>,
    ) -> Vec<String> {
        let mut argv = Vec::new();
        argv.push(self.program.clone());
        argv.extend(self.options.iter().cloned());
        argv.extend(extra_options.iter().map(|arg| (*arg).to_string()));
        argv.push(self.target.clone());
        if let Some(remote_command) = remote_command {
            argv.push(remote_command.to_string());
        }
        argv
    }

    pub fn to_command_with_extra_options(&self, extra_options: &[&str]) -> Command {
        if self.is_local() {
            // Local execution: callers append the remote command as a single
            // shell string, so run it via `sh -c <string>` on this host.
            let mut cmd = silent_command("sh");
            cmd.arg("-c");
            return cmd;
        }
        let mut cmd = silent_command(&self.program);
        cmd.args(&self.options);
        cmd.args(extra_options);
        cmd.arg(&self.target);
        cmd
    }

    pub fn filtered_options(&self, allowed: &[&str]) -> Vec<String> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < self.options.len() {
            let option = &self.options[i];
            if allowed.contains(&option.as_str()) {
                out.push(option.clone());
                if option_takes_value(option) && i + 1 < self.options.len() {
                    i += 1;
                    out.push(self.options[i].clone());
                }
            } else if option_takes_value(option) {
                i += 1;
            }
            i += 1;
        }
        out
    }
}

pub fn quote_posix_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_preserves_quoted_windows_path() {
        let parts = split_command_line("ssh -i 'C:\\Users\\Jane Doe\\.ssh\\id_ed25519' me@host");
        assert_eq!(
            parts,
            vec![
                "ssh",
                "-i",
                "C:\\Users\\Jane Doe\\.ssh\\id_ed25519",
                "me@host"
            ]
        );
    }

    #[test]
    fn split_preserves_unescaped_backslashes() {
        let parts = split_command_line(r"ssh -i C:\Users\Jane\.ssh\id me@host");
        assert_eq!(parts[2], r"C:\Users\Jane\.ssh\id");
    }

    #[test]
    fn split_preserves_windows_unc_backslashes() {
        let parts =
            split_command_line_for_platform(r"ssh -i \\server\share\id_ed25519 me@host", true);
        assert_eq!(parts[2], r"\\server\share\id_ed25519");
    }

    #[test]
    fn split_preserves_windows_doubled_single_quote() {
        let parts = split_command_line_for_platform(
            r"ssh -i 'C:\Users\O''Neil\.ssh\id_ed25519' me@host",
            true,
        );
        assert_eq!(parts[2], r"C:\Users\O'Neil\.ssh\id_ed25519");
        assert_eq!(parts[3], "me@host");
    }

    #[test]
    fn parse_drops_remote_command_after_target() {
        let parsed = parse_ssh_command("ssh -t -p 2222 -i '/keys/a b' me@host 'echo hi'").unwrap();
        assert_eq!(parsed.program, "ssh");
        assert_eq!(parsed.options, vec!["-p", "2222", "-i", "/keys/a b"]);
        assert_eq!(parsed.target, "me@host");
        assert_eq!(parsed.tty_mode, Some(SshTtyMode::Allocate));
    }

    #[test]
    fn parse_accepts_host_alias_and_l_user() {
        let parsed = parse_ssh_command("ssh -l me prod-alias").unwrap();
        assert_eq!(parsed.options, vec!["-l", "me"]);
        assert_eq!(parsed.target, "prod-alias");
    }

    #[test]
    fn parse_value_options_before_host_aliases() {
        let parsed = parse_ssh_command("ssh -B en0 -p2222 -Jjump prod-alias uptime").unwrap();
        assert_eq!(
            parsed.options,
            vec!["-B", "en0", "-p", "2222", "-J", "jump"]
        );
        assert_eq!(parsed.target, "prod-alias");
    }

    #[test]
    fn parse_preserves_disable_tty_mode() {
        let parsed = parse_ssh_command("ssh -T prod-alias uptime").unwrap();
        assert_eq!(parsed.target, "prod-alias");
        assert_eq!(parsed.tty_mode, Some(SshTtyMode::Disable));
    }

    #[test]
    fn parse_rejects_non_ssh_wrappers() {
        assert!(parse_ssh_command("sshpass -p pw ssh me@host").is_none());
    }

    #[test]
    fn quote_posix_single_quotes() {
        assert_eq!(quote_posix_shell_arg("a'b"), "'a'\\''b'");
    }

    #[test]
    fn typed_argv_preserves_options_and_remote_command() {
        let ssh = SshCommand {
            program: "ssh".to_string(),
            options: vec![
                "-J".to_string(),
                "jump".to_string(),
                "-i".to_string(),
                "C:\\Users\\Jane Doe\\.ssh\\id_ed25519".to_string(),
            ],
            target: "me@host".to_string(),
            tty_mode: None,
        };
        assert_eq!(
            ssh.argv_with_extra_options(&["-t"], Some("claude --resume 'a b'")),
            vec![
                "ssh",
                "-J",
                "jump",
                "-i",
                "C:\\Users\\Jane Doe\\.ssh\\id_ed25519",
                "-t",
                "me@host",
                "claude --resume 'a b'"
            ]
        );
    }
}
