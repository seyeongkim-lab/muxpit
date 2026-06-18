use std::ffi::OsString;
use std::path::PathBuf;

pub const SOCKET_FILE_NAME: &str = "wmux.sock";

pub fn unix_socket_path_from_env(
    override_path: Option<OsString>,
    runtime_dir: Option<OsString>,
    user: Option<OsString>,
) -> PathBuf {
    if let Some(path) = override_path.filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    if let Some(dir) = runtime_dir.filter(|value| !value.is_empty()) {
        return PathBuf::from(dir).join("wmux").join(SOCKET_FILE_NAME);
    }

    let user = user
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .map(sanitize_socket_user)
        .unwrap_or_else(|| "user".to_string());
    PathBuf::from(format!("/tmp/wmux-{user}.sock"))
}

#[cfg(unix)]
pub fn unix_socket_path() -> PathBuf {
    unix_socket_path_from_env(
        std::env::var_os("WMUX_SOCKET_PATH"),
        std::env::var_os("XDG_RUNTIME_DIR"),
        std::env::var_os("USER"),
    )
}

fn sanitize_socket_user(value: String) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::unix_socket_path_from_env;

    #[test]
    fn socket_path_prefers_override() {
        let path = unix_socket_path_from_env(
            Some("/custom/wmux.sock".into()),
            Some("/run/user/1000".into()),
            Some("me".into()),
        );
        assert_eq!(path, std::path::PathBuf::from("/custom/wmux.sock"));
    }

    #[test]
    fn socket_path_uses_runtime_dir() {
        let path =
            unix_socket_path_from_env(None, Some("/run/user/1000".into()), Some("me".into()));
        assert_eq!(
            path,
            std::path::PathBuf::from("/run/user/1000/wmux/wmux.sock")
        );
    }

    #[test]
    fn socket_path_falls_back_to_user_scoped_tmp() {
        let path = unix_socket_path_from_env(None, None, Some("name with space".into()));
        assert_eq!(
            path,
            std::path::PathBuf::from("/tmp/wmux-name_with_space.sock")
        );
    }
}
