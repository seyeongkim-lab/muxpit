use crate::command::apply_no_window;
use crate::ssh_command::{quote_posix_shell_arg, SshCommand};
use serde::Serialize;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub id: String,
    pub name: String,
    pub attached: bool,
    pub windows: u32,
    pub activity: u64,
}

fn build_ssh(ssh: &SshCommand) -> Command {
    let mut cmd = ssh.to_command_with_extra_options(&[
        "-o",
        "ConnectTimeout=5",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]);
    apply_no_window(&mut cmd);
    cmd.stderr(Stdio::null());
    cmd
}

fn safe_session_token(s: &str) -> Option<String> {
    if s.is_empty() {
        return None;
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '$' | '@'))
    {
        Some(s.to_string())
    } else {
        None
    }
}

fn safe_new_session_name(s: &str) -> Option<String> {
    if s.is_empty() {
        return None;
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        Some(s.to_string())
    } else {
        None
    }
}

pub fn list_sessions(ssh: &SshCommand) -> Result<Vec<TmuxSession>, String> {
    let mut cmd = build_ssh(ssh);
    cmd.arg(
        "tmux list-sessions -F '#{session_id}|#{session_name}|#{session_attached}|#{session_windows}|#{session_activity}' 2>/dev/null",
    );
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut sessions = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 5 {
            continue;
        }
        sessions.push(TmuxSession {
            id: parts[0].to_string(),
            name: parts[1].to_string(),
            attached: parts[2].parse::<u32>().unwrap_or(0) > 0,
            windows: parts[3].parse().unwrap_or(0),
            activity: parts[4].parse().unwrap_or(0),
        });
    }
    Ok(sessions)
}

pub fn switch_client(
    ssh: &SshCommand,
    wrapper_session: &str,
    target_session: &str,
) -> Result<(), String> {
    let wrapper =
        safe_session_token(wrapper_session).ok_or_else(|| "invalid wrapper".to_string())?;
    let target = safe_session_token(target_session).ok_or_else(|| "invalid target".to_string())?;
    let remote = format!(
        "ttys=$(tmux list-clients -t {wrapper} -F '#{{client_tty}}' 2>/dev/null); \
        if [ -z \"$ttys\" ]; then exit 1; \
         else for t in $ttys; do tmux switch-client -c \"$t\" -t {target}; done; fi",
        wrapper = quote_posix_shell_arg(&wrapper),
        target = quote_posix_shell_arg(&target)
    );
    let mut cmd = build_ssh(ssh);
    cmd.arg(remote);
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        return Err(format!("switch-client exited with {}", out.status));
    }
    Ok(())
}

pub fn new_session(ssh: &SshCommand, name: Option<&str>) -> Result<String, String> {
    let mut cmd = build_ssh(ssh);
    let remote = match name {
        Some(n) => {
            let safe = safe_new_session_name(n).ok_or_else(|| "invalid name".to_string())?;
            format!(
                "tmux new-session -d -P -F '#{{session_id}}' -s {}",
                quote_posix_shell_arg(&safe)
            )
        }
        None => "tmux new-session -d -P -F '#{session_id}'".to_string(),
    };
    cmd.arg(remote);
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        return Err(format!("new-session exited with {}", out.status));
    }
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if id.is_empty() {
        return Err("tmux returned empty session id".into());
    }
    Ok(id)
}

pub fn kill_session(ssh: &SshCommand, session: &str) -> Result<(), String> {
    let s = safe_session_token(session).ok_or_else(|| "invalid session".to_string())?;
    let mut cmd = build_ssh(ssh);
    let remote = format!(
        "alt=$(tmux list-sessions -F '#{{session_id}}' 2>/dev/null \
                | grep -F -v -x '{s}' | head -n1); \
         ttys=$(tmux list-clients -t {quoted_s} -F '#{{client_tty}}' 2>/dev/null); \
         if [ -n \"$ttys\" ] && [ -n \"$alt\" ]; then \
           for t in $ttys; do tmux switch-client -c \"$t\" -t \"$alt\"; done; \
         fi; \
         tmux kill-session -t {quoted_s}",
        quoted_s = quote_posix_shell_arg(&s)
    );
    cmd.arg(remote);
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        return Err(format!("kill-session exited with {}", out.status));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_command::parse_ssh_command;

    fn parse_ssh_args(ssh_command: &str) -> Option<(String, Vec<String>, String)> {
        parse_ssh_command(ssh_command).map(|cmd| (cmd.program, cmd.options, cmd.target))
    }

    #[test]
    fn parse_basic() {
        let (p, o, t) = parse_ssh_args("ssh -p 2222 -i /k user@host").unwrap();
        assert_eq!(p, "ssh");
        assert_eq!(o, vec!["-p", "2222", "-i", "/k"]);
        assert_eq!(t, "user@host");
    }

    #[test]
    fn parse_passthrough_options() {
        let (_, o, t) = parse_ssh_args("ssh -o StrictHostKeyChecking=no me@x").unwrap();
        assert!(o.contains(&"-o".to_string()));
        assert_eq!(t, "me@x");
    }

    #[test]
    fn parse_quoted_identity_path() {
        let (_, o, t) =
            parse_ssh_args("ssh -p 2222 -i 'C:\\Users\\Jane Doe\\.ssh\\id_ed25519' me@x").unwrap();
        assert_eq!(
            o,
            vec![
                "-p".to_string(),
                "2222".to_string(),
                "-i".to_string(),
                "C:\\Users\\Jane Doe\\.ssh\\id_ed25519".to_string()
            ]
        );
        assert_eq!(t, "me@x");
    }

    #[test]
    fn parse_no_target() {
        assert!(parse_ssh_args("ssh -p 22").is_none());
    }

    #[test]
    fn safe_token_accepts() {
        assert!(safe_session_token("$3").is_some());
        assert!(safe_session_token("wmux-host").is_some());
        assert!(safe_session_token("foo_bar").is_some());
    }

    #[test]
    fn safe_token_rejects() {
        assert!(safe_session_token("foo bar").is_none());
        assert!(safe_session_token("foo;rm").is_none());
        assert!(safe_session_token("foo.bar").is_none());
        assert!(safe_session_token("").is_none());
    }

    #[test]
    fn safe_new_session_name_rejects_tmux_id_expansion_tokens() {
        assert!(safe_new_session_name("project-1").is_some());
        assert!(safe_new_session_name("$HOME").is_none());
        assert!(safe_new_session_name("$1").is_none());
    }
}
