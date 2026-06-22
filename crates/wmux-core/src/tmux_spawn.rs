use crate::ssh_command::{resolve_ssh_command, SshCommand};

pub fn sanitize_tmux_session_name(session_name: &str) -> String {
    session_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn build_tmux_attach_argv(
    ssh_command: Option<&str>,
    ssh_connection: Option<SshCommand>,
    session_name: &str,
) -> Result<Vec<String>, String> {
    let safe = sanitize_tmux_session_name(session_name);
    let tmux_inner = format!(
        "sh -c \"tmux -u has-session -t {name} 2>/dev/null || tmux -u new-session -d -s {name}; tmux -u set-option -t {name} mouse off; tmux -u set-option -g detach-on-destroy off; exec tmux -u attach -t {name}\"",
        name = safe
    );
    let ssh = resolve_ssh_command(ssh_command, ssh_connection)
        .ok_or_else(|| "Invalid SSH command".to_string())?;
    Ok(ssh.argv_with_extra_options(&["-tt"], Some(&tmux_inner)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmux_attach_argv_forces_tty_and_sanitizes_name() {
        let argv =
            build_tmux_attach_argv(Some("ssh -p 2222 me@host"), None, "wmux-10.0.0.5").unwrap();
        assert_eq!(argv[0], "ssh");
        assert!(argv.contains(&"-tt".to_string()));
        assert!(argv.contains(&"me@host".to_string()));
        assert!(argv.last().unwrap().contains("wmux-10_0_0_5"));
    }
}
