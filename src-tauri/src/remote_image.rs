use crate::platform::command::silent_command;
use crate::ssh_command::SshCommand;
use std::process::Stdio;

const IMAGE_UPLOAD_OPTION_ALLOWLIST: &[&str] = &["-p", "-i", "-J", "-F", "-o", "-l"];

pub const REMOTE_IMAGE_UPLOAD_SCRIPT: &str = "umask 077; dir=\"$HOME/.wmux/screenshots\"; \
     mkdir -p \"$dir\" && wmux_image_path=$(mktemp \"$dir/wmux-XXXXXX.png\") && \
     cat > \"$wmux_image_path\" && chmod 600 \"$wmux_image_path\" && printf '%s\\n' \"$wmux_image_path\"";

/// Build the side-channel SSH argv used for clipboard image upload.
///
/// The source SSH command may be an interactive pane launcher, such as
/// `ssh -t host "/bin/sh -lc '...'"`. The upload path must not inherit tty
/// allocation, port forwarding, or the pane's remote command because binary
/// stdin must reach a simple remote `cat` process unchanged.
pub fn image_upload_ssh_args(ssh: &SshCommand) -> Vec<String> {
    let mut args = ssh.filtered_options(IMAGE_UPLOAD_OPTION_ALLOWLIST);
    args.extend([
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
    ]);
    args.push(ssh.target.clone());
    args.push(REMOTE_IMAGE_UPLOAD_SCRIPT.to_string());
    args
}

/// Upload a clipboard image to the pane's SSH host and return the remote path.
pub fn push_image_to_remote_sync(ssh: &SshCommand, image_base64: &str) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .map_err(|e| format!("invalid image data: {e}"))?;

    let mut cmd = silent_command(&ssh.program);
    cmd.args(image_upload_ssh_args(ssh));
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("ssh spawn failed: {e}"))?;
    {
        use std::io::Write as _;
        let mut stdin = child.stdin.take().ok_or("ssh stdin unavailable")?;
        stdin
            .write_all(&bytes)
            .map_err(|e| format!("upload failed: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("ssh failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("upload failed: {}", err.trim()));
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Err("upload failed: remote returned no path".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_command::SshTtyMode;

    #[test]
    fn image_upload_args_keep_only_side_channel_safe_ssh_options() {
        let ssh = SshCommand {
            program: "ssh".to_string(),
            options: vec![
                "-t".to_string(),
                "-p".to_string(),
                "2222".to_string(),
                "-i".to_string(),
                "/keys/id_ed25519".to_string(),
                "-J".to_string(),
                "jump".to_string(),
                "-L".to_string(),
                "8080:localhost:80".to_string(),
                "-o".to_string(),
                "ProxyCommand=nc %h %p".to_string(),
            ],
            target: "me@host".to_string(),
            tty_mode: Some(SshTtyMode::Allocate),
        };

        let args = image_upload_ssh_args(&ssh);

        assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-i", "/keys/id_ed25519"]));
        assert!(args.windows(2).any(|pair| pair == ["-J", "jump"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ProxyCommand=nc %h %p"]));
        assert!(!args.iter().any(|arg| arg == "-t"));
        assert!(!args.iter().any(|arg| arg == "-L"));
        assert_eq!(args[args.len() - 2], "me@host");
        assert_eq!(
            args.last().map(String::as_str),
            Some(REMOTE_IMAGE_UPLOAD_SCRIPT)
        );
    }

    #[test]
    fn remote_image_script_does_not_assign_zsh_path_special_parameter() {
        assert!(REMOTE_IMAGE_UPLOAD_SCRIPT.contains("wmux_image_path="));
        assert!(!REMOTE_IMAGE_UPLOAD_SCRIPT.contains(" path="));
    }

    #[test]
    fn image_upload_rejects_invalid_base64_before_spawning_ssh() {
        let ssh = SshCommand {
            program: "ssh".to_string(),
            options: Vec::new(),
            target: "me@host".to_string(),
            tty_mode: None,
        };

        let err = push_image_to_remote_sync(&ssh, "%%%").unwrap_err();
        assert!(err.contains("invalid image data"));
    }
}
