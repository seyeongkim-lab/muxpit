use crate::ssh_command::{quote_posix_shell_arg, ssh_target_index};
use base64::{engine::general_purpose::STANDARD, Engine as _};

const REMOTE_CLI: &str = include_str!("../assets/wmux-remote-cli.py");

pub(crate) fn remote_relay_port(token: &str) -> u16 {
    let hash = token.bytes().fold(2_166_136_261_u32, |hash, byte| {
        hash.wrapping_mul(16_777_619) ^ u32::from(byte)
    });
    40_000 + (hash % 20_000) as u16
}

pub(crate) fn wrap_ssh_control_relay(
    argv: &[String],
    local_port: u16,
    workspace_id: &str,
    surface_id: &str,
    token: &str,
) -> Option<Vec<String>> {
    let target_index = ssh_target_index(argv)?;
    let remote_port = remote_relay_port(token);
    let original_remote = argv
        .get(target_index + 1..)
        .filter(|parts| !parts.is_empty())
        .map(|parts| parts.join(" "))
        .unwrap_or_else(|| "exec \"${SHELL:-/bin/sh}\" -l".to_string());
    let remote = remote_bootstrap(
        workspace_id,
        surface_id,
        token,
        remote_port,
        &original_remote,
    );
    let mut wrapped = argv[..target_index].to_vec();
    wrapped.push("-R".to_string());
    wrapped.push(format!("127.0.0.1:{remote_port}:127.0.0.1:{local_port}"));
    wrapped.push(argv[target_index].clone());
    wrapped.push(remote);
    Some(wrapped)
}

fn remote_bootstrap(
    workspace_id: &str,
    surface_id: &str,
    token: &str,
    remote_port: u16,
    original_remote: &str,
) -> String {
    let encoded_cli = STANDARD.encode(REMOTE_CLI);
    let workspace_id = quote_posix_shell_arg(workspace_id);
    let surface_id = quote_posix_shell_arg(surface_id);
    let token = quote_posix_shell_arg(token);
    let writer = quote_posix_shell_arg(&format!(
        "import base64,os;open(os.environ['WMUX_REMOTE_CLI'],'wb').write(base64.b64decode('{encoded_cli}'))"
    ));
    let install = format!(
        "if command -v python3 >/dev/null 2>&1; then WMUX_REMOTE_CLI=\"$wmux_dir/wmux-cli\" python3 -c {writer}; chmod 700 \"$wmux_dir/wmux-cli\"; ln -sf wmux-cli \"$wmux_dir/wmux\"; export PATH=\"$wmux_dir:$PATH\"; else echo '[wmux] remote control needs python3' >&2; fi"
    );
    vec![
        "wmux_dir=${TMPDIR:-/tmp}/wmux-${UID:-user}".to_string(),
        "mkdir -p \"$wmux_dir\" && chmod 700 \"$wmux_dir\"".to_string(),
        format!("export WMUX_WORKSPACE_ID={workspace_id}"),
        format!("export WMUX_SURFACE_ID={surface_id}"),
        format!("export WMUX_CONTROL_TOKEN={token}"),
        format!("export WMUX_CONTROL_PORT={remote_port}"),
        "export WMUX_BUNDLED_CLI_PATH=\"$wmux_dir/wmux-cli\"".to_string(),
        install,
        original_remote.to_string(),
    ]
    .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_port_is_stable_and_unprivileged() {
        let port = remote_relay_port("0123456789abcdef0123456789abcdef");
        assert!((40_000..=59_999).contains(&port));
        assert_eq!(port, remote_relay_port("0123456789abcdef0123456789abcdef"));
    }

    #[test]
    fn wraps_ssh_target_with_reverse_forward_and_remote_context() {
        let argv = vec![
            "ssh".to_string(),
            "-tt".to_string(),
            "user@example.com".to_string(),
            "exec codex".to_string(),
        ];
        let wrapped = wrap_ssh_control_relay(
            &argv,
            37_321,
            "ws-1",
            "pane-1",
            "0123456789abcdef0123456789abcdef",
        )
        .unwrap();

        let target = wrapped
            .iter()
            .position(|part| part == "user@example.com")
            .unwrap();
        assert_eq!(wrapped[target - 2], "-R");
        assert!(wrapped[target - 1].starts_with("127.0.0.1:"));
        let remote = &wrapped[target + 1];
        assert!(remote.contains("WMUX_WORKSPACE_ID"));
        assert!(remote.contains("WMUX_SURFACE_ID"));
        assert!(remote.contains("WMUX_CONTROL_TOKEN"));
        assert!(wrapped[target - 1].ends_with(":127.0.0.1:37321"));
        assert!(remote.contains("WMUX_CONTROL_PORT"));
        assert!(remote.contains("exec codex"));
    }

    #[test]
    fn leaves_non_ssh_argv_unchanged() {
        let argv = vec!["codex".to_string()];
        assert!(wrap_ssh_control_relay(&argv, 37_321, "ws", "pane", "token").is_none());
    }

    #[test]
    fn remote_cli_supports_browser_open() {
        assert!(REMOTE_CLI.contains("\"browser-open\""));
        assert!(REMOTE_CLI.contains("\"open\", \"navigate\""));
    }

    #[cfg(unix)]
    #[test]
    fn remote_bootstrap_is_valid_posix_shell() {
        let script = remote_bootstrap("ws", "pane", "token", 45_000, "exec codex");
        let status = std::process::Command::new("sh")
            .args(["-n", "-c", &script])
            .status()
            .unwrap();
        assert!(status.success());
    }
}
