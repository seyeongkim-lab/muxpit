use std::path::{Path, PathBuf};

pub fn bundled_cli_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| bundled_cli_path_for_exe(&exe))
}

pub(crate) fn bundled_cli_path_for_exe(exe: &Path) -> Option<PathBuf> {
    let candidate = exe.parent()?.join(cli_executable_name());
    candidate.is_file().then_some(candidate)
}

fn cli_executable_name() -> &'static str {
    if cfg!(windows) {
        "muxpit-cli.exe"
    } else {
        "muxpit-cli"
    }
}

pub fn install_cli_symlink() -> Result<PathBuf, String> {
    let cli_path = bundled_cli_path()
        .ok_or_else(|| "Bundled muxpit-cli was not found next to the app executable".to_string())?;
    let link_path = default_cli_symlink_path()?;
    install_cli_symlink_to(&cli_path, &link_path)?;
    Ok(link_path)
}

pub(crate) fn default_cli_symlink_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())?;
    Ok(default_cli_symlink_path_for_home(&home))
}

pub(crate) fn default_cli_symlink_path_for_home(home: &Path) -> PathBuf {
    home.join(".local").join("bin").join("muxpit-cli")
}

#[cfg(unix)]
pub(crate) fn install_cli_symlink_to(cli_path: &Path, link_path: &Path) -> Result<(), String> {
    use std::fs;
    use std::os::unix::fs::symlink;

    if !cli_path.is_file() {
        return Err(format!(
            "Bundled muxpit-cli does not exist: {}",
            cli_path.display()
        ));
    }

    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Could not create CLI install directory {}: {e}",
                parent.display()
            )
        })?;
    }

    match fs::symlink_metadata(link_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let current_target = fs::read_link(link_path).map_err(|e| {
                format!(
                    "Could not read existing CLI symlink {}: {e}",
                    link_path.display()
                )
            })?;
            if current_target == cli_path {
                return Ok(());
            }
            fs::remove_file(link_path).map_err(|e| {
                format!(
                    "Could not replace existing CLI symlink {}: {e}",
                    link_path.display()
                )
            })?;
        }
        Ok(_) => {
            return Err(format!(
                "{} already exists and is not a symlink",
                link_path.display()
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "Could not inspect existing CLI path {}: {e}",
                link_path.display()
            ));
        }
    }

    symlink(cli_path, link_path).map_err(|e| {
        format!(
            "Could not create CLI symlink {} -> {}: {e}",
            link_path.display(),
            cli_path.display()
        )
    })
}

#[cfg(not(unix))]
pub(crate) fn install_cli_symlink_to(_cli_path: &Path, _link_path: &Path) -> Result<(), String> {
    Err("CLI symlink installation is only supported on Unix-like systems".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn bundled_cli_path_uses_executable_directory() {
        let dir = unique_test_dir("bundled_cli_path");
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(if cfg!(windows) { "muxpit.exe" } else { "muxpit" });
        let cli = dir.join(cli_executable_name());
        fs::write(&exe, "").unwrap();
        fs::write(&cli, "").unwrap();

        assert_eq!(bundled_cli_path_for_exe(&exe), Some(cli));

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn default_cli_symlink_path_uses_local_bin() {
        assert_eq!(
            default_cli_symlink_path_for_home(Path::new("/Users/alice")),
            PathBuf::from("/Users/alice/.local/bin/muxpit-cli")
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_cli_symlink_creates_and_replaces_symlink() {
        let dir = unique_test_dir("install_cli_symlink");
        let old_dir = dir.join("old");
        let new_dir = dir.join("new");
        let bin_dir = dir.join("home/.local/bin");
        fs::create_dir_all(&old_dir).unwrap();
        fs::create_dir_all(&new_dir).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();

        let old_cli = old_dir.join("muxpit-cli");
        let new_cli = new_dir.join("muxpit-cli");
        let link = bin_dir.join("muxpit-cli");
        fs::write(&old_cli, "old").unwrap();
        fs::write(&new_cli, "new").unwrap();

        install_cli_symlink_to(&old_cli, &link).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), old_cli);

        install_cli_symlink_to(&new_cli, &link).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), new_cli);

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn install_cli_symlink_refuses_regular_file() {
        let dir = unique_test_dir("install_cli_regular_file");
        fs::create_dir_all(&dir).unwrap();
        let cli = dir.join("muxpit-cli");
        let link = dir.join("link");
        fs::write(&cli, "cli").unwrap();
        fs::write(&link, "existing").unwrap();

        let error = install_cli_symlink_to(&cli, &link).unwrap_err();
        assert!(error.contains("is not a symlink"));

        fs::remove_dir_all(dir).unwrap();
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("muxpit-{name}-{nonce}"))
    }
}
