use crate::platform::command::silent_command;
use crate::ssh_command::SshCommand;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const IMAGE_UPLOAD_OPTION_ALLOWLIST: &[&str] = &["-p", "-i", "-J", "-F", "-o", "-l"];

pub const REMOTE_IMAGE_UPLOAD_SCRIPT: &str = "umask 077; dir=\"$HOME/.muxpit/screenshots\"; \
     mkdir -p \"$dir\" && muxpit_image_path=$(mktemp \"$dir/muxpit-XXXXXX.png\") && \
     cat > \"$muxpit_image_path\" && chmod 600 \"$muxpit_image_path\" && printf '%s\\n' \"$muxpit_image_path\"";

#[derive(Clone, Copy)]
#[cfg_attr(not(test), allow(dead_code))]
enum HomeDirPlatform {
    Unix,
    Windows,
}

fn decode_image_base64(image_base64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .map_err(|e| format!("invalid image data: {e}"))
}

fn home_dir() -> Option<PathBuf> {
    home_dir_from_env(
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        std::env::var_os("HOMEDRIVE"),
        std::env::var_os("HOMEPATH"),
    )
}

fn home_dir_from_env(
    home: Option<std::ffi::OsString>,
    userprofile: Option<std::ffi::OsString>,
    homedrive: Option<std::ffi::OsString>,
    homepath: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    #[cfg(windows)]
    const PLATFORM: HomeDirPlatform = HomeDirPlatform::Windows;
    #[cfg(not(windows))]
    const PLATFORM: HomeDirPlatform = HomeDirPlatform::Unix;

    home_dir_from_env_for_platform(PLATFORM, home, userprofile, homedrive, homepath)
}

fn home_dir_from_env_for_platform(
    platform: HomeDirPlatform,
    home: Option<std::ffi::OsString>,
    userprofile: Option<std::ffi::OsString>,
    homedrive: Option<std::ffi::OsString>,
    homepath: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if matches!(platform, HomeDirPlatform::Windows) {
        if let Some(path) = non_empty_path(userprofile) {
            return Some(path);
        }
        match (homedrive, homepath) {
            (Some(drive), Some(path)) if !drive.is_empty() && !path.is_empty() => {
                return Some(PathBuf::from(format!(
                    "{}{}",
                    drive.to_string_lossy(),
                    path.to_string_lossy()
                )));
            }
            _ => {}
        }
    }

    non_empty_path(home)
}

fn non_empty_path(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value.filter(|value| !value.is_empty()).map(PathBuf::from)
}

fn local_screenshot_dir() -> Result<PathBuf, String> {
    home_dir()
        .map(|home| home.join(".muxpit").join("screenshots"))
        .ok_or_else(|| "could not resolve home directory".to_string())
}

fn ensure_private_image_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("image directory create failed: {e}"))?;

    #[cfg(unix)]
    {
        if let Some(parent) = dir
            .parent()
            .filter(|parent| parent.file_name().and_then(|name| name.to_str()) == Some(".muxpit"))
        {
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("image directory permission update failed: {e}"))?;
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("image directory permission update failed: {e}"))?;
    }

    Ok(())
}

fn unique_image_file(dir: &Path) -> Result<(PathBuf, File), String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();

    for attempt in 0..1000_u16 {
        let path = dir.join(format!("muxpit-{stamp}-{pid}-{attempt}.png"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("image file create failed: {err}")),
        }
    }

    Err("image file create failed: could not allocate unique path".to_string())
}

fn save_image_bytes_to_dir(dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    ensure_private_image_dir(dir)?;
    let (path, mut file) = unique_image_file(dir)?;
    file.write_all(bytes)
        .map_err(|e| format!("image write failed: {e}"))?;
    Ok(path)
}

pub fn save_image_locally_sync(image_base64: &str) -> Result<String, String> {
    let bytes = decode_image_base64(image_base64)?;
    let path = save_image_bytes_to_dir(&local_screenshot_dir()?, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

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
    let bytes = decode_image_base64(image_base64)?;

    let mut cmd = silent_command(&ssh.program);
    cmd.args(image_upload_ssh_args(ssh));
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("ssh spawn failed: {e}"))?;
    {
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

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "muxpit-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn local_image_save_writes_file_under_requested_dir() {
        let root = unique_test_dir("local-image-save");
        let dir = root.join(".muxpit").join("screenshots");
        let path = save_image_bytes_to_dir(&dir, b"image").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"image");
        assert!(path.starts_with(&dir));
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("png")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(root.join(".muxpit"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_image_save_rejects_invalid_base64_before_writing() {
        let err = save_image_locally_sync("%%%").unwrap_err();
        assert!(err.contains("invalid image data"));
    }

    #[test]
    fn home_dir_uses_home_on_non_windows() {
        let home = home_dir_from_env(Some("/home/me".into()), None, None, None).unwrap();

        #[cfg(not(windows))]
        assert_eq!(home, PathBuf::from("/home/me"));
    }

    #[test]
    fn home_dir_prefers_userprofile_for_windows_model() {
        let home = home_dir_from_env_for_platform(
            HomeDirPlatform::Windows,
            Some("/home/me".into()),
            Some(r"C:\Users\me".into()),
            Some("D:".into()),
            Some(r"\Users\fallback".into()),
        )
        .unwrap();

        assert_eq!(home, PathBuf::from(r"C:\Users\me"));
    }

    #[test]
    fn home_dir_uses_drive_and_path_for_windows_model() {
        let home = home_dir_from_env_for_platform(
            HomeDirPlatform::Windows,
            Some("/home/me".into()),
            None,
            Some("D:".into()),
            Some(r"\Users\me".into()),
        )
        .unwrap();

        assert_eq!(home, PathBuf::from(r"D:\Users\me"));
    }

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
        assert!(REMOTE_IMAGE_UPLOAD_SCRIPT.contains("muxpit_image_path="));
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
