use std::ffi::OsString;
use std::path::PathBuf;

pub const SOCKET_FILE_NAME: &str = "wmux.sock";
pub const DEFAULT_WINDOWS_PIPE_PREFIX: &str = r"\\.\pipe\wmux";
pub const IPC_NAMESPACE_ENV: &str = "WMUX_IPC_NAMESPACE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnixSocketEndpoint {
    pub path: PathBuf,
    pub secure_parent: bool,
}

pub fn unix_socket_endpoint_from_env(
    override_path: Option<OsString>,
    namespace: Option<OsString>,
    runtime_dir: Option<OsString>,
    user: Option<OsString>,
) -> UnixSocketEndpoint {
    if let Some(path) = override_path.filter(|value| !value.is_empty()) {
        return UnixSocketEndpoint {
            path: PathBuf::from(path),
            secure_parent: false,
        };
    }
    let namespace = sanitized_namespace(namespace);
    if let Some(dir) = runtime_dir.filter(|value| !value.is_empty()) {
        let mut path = PathBuf::from(dir).join("wmux");
        if let Some(namespace) = namespace.as_deref() {
            path = path.join(namespace);
        }
        return UnixSocketEndpoint {
            path: path.join(SOCKET_FILE_NAME),
            secure_parent: true,
        };
    }

    let user = user
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .map(sanitize_socket_user)
        .unwrap_or_else(|| "user".to_string());
    let parent = match namespace {
        Some(namespace) => format!("wmux-{user}-{namespace}"),
        None => format!("wmux-{user}"),
    };
    UnixSocketEndpoint {
        path: PathBuf::from("/tmp").join(parent).join(SOCKET_FILE_NAME),
        secure_parent: true,
    }
}

pub fn unix_socket_path_from_env(
    override_path: Option<OsString>,
    namespace: Option<OsString>,
    runtime_dir: Option<OsString>,
    user: Option<OsString>,
) -> PathBuf {
    unix_socket_endpoint_from_env(override_path, namespace, runtime_dir, user).path
}

#[cfg(unix)]
pub fn unix_socket_endpoint() -> UnixSocketEndpoint {
    unix_socket_endpoint_from_env(
        std::env::var_os("WMUX_SOCKET_PATH"),
        std::env::var_os(IPC_NAMESPACE_ENV),
        std::env::var_os("XDG_RUNTIME_DIR"),
        std::env::var_os("USER"),
    )
}

#[cfg(unix)]
pub fn unix_socket_path() -> PathBuf {
    unix_socket_endpoint_from_env(
        std::env::var_os("WMUX_SOCKET_PATH"),
        std::env::var_os(IPC_NAMESPACE_ENV),
        std::env::var_os("XDG_RUNTIME_DIR"),
        std::env::var_os("USER"),
    )
    .path
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

fn sanitized_namespace(value: Option<OsString>) -> Option<String> {
    value
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .map(sanitize_socket_user)
}

pub fn windows_pipe_name_from_env(
    override_name: Option<OsString>,
    namespace: Option<OsString>,
    user: Option<OsString>,
) -> String {
    if let Some(value) = override_name.and_then(|value| value.into_string().ok()) {
        if !value.trim().is_empty() {
            return value;
        }
    }

    let user = user
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.is_empty())
        .map(sanitize_socket_user)
        .unwrap_or_else(|| "user".to_string());
    match sanitized_namespace(namespace) {
        Some(namespace) => format!("{DEFAULT_WINDOWS_PIPE_PREFIX}-{user}-{namespace}"),
        None => format!("{DEFAULT_WINDOWS_PIPE_PREFIX}-{user}"),
    }
}

#[cfg(windows)]
pub fn windows_pipe_name() -> String {
    windows_pipe_name_from_env(
        std::env::var_os("WMUX_PIPE_NAME"),
        std::env::var_os(IPC_NAMESPACE_ENV),
        std::env::var_os("USERNAME"),
    )
}

pub fn windows_mutex_name_from_pipe(pipe_name: &str) -> String {
    let suffix: String = pipe_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("Local\\{suffix}-single-instance")
}

#[cfg(test)]
mod tests {
    use super::{
        unix_socket_endpoint_from_env, unix_socket_path_from_env, windows_mutex_name_from_pipe,
        windows_pipe_name_from_env,
    };

    #[test]
    fn socket_path_prefers_override() {
        let endpoint = unix_socket_endpoint_from_env(
            Some("/custom/wmux.sock".into()),
            Some("dev-test".into()),
            Some("/run/user/1000".into()),
            Some("me".into()),
        );
        assert_eq!(endpoint.path, std::path::PathBuf::from("/custom/wmux.sock"));
        assert!(!endpoint.secure_parent);
    }

    #[test]
    fn socket_path_uses_runtime_dir() {
        let endpoint = unix_socket_endpoint_from_env(
            None,
            None,
            Some("/run/user/1000".into()),
            Some("me".into()),
        );
        assert_eq!(
            endpoint.path,
            std::path::PathBuf::from("/run/user/1000/wmux/wmux.sock")
        );
        assert!(endpoint.secure_parent);
    }

    #[test]
    fn socket_path_uses_namespace_when_present() {
        let endpoint = unix_socket_endpoint_from_env(
            None,
            Some("dev 1".into()),
            Some("/run/user/1000".into()),
            Some("me".into()),
        );
        assert_eq!(
            endpoint.path,
            std::path::PathBuf::from("/run/user/1000/wmux/dev_1/wmux.sock")
        );
        assert!(endpoint.secure_parent);
    }

    #[test]
    fn socket_path_falls_back_to_private_user_tmp_dir() {
        let endpoint =
            unix_socket_endpoint_from_env(None, None, None, Some("name with space".into()));
        assert_eq!(
            endpoint.path,
            std::path::PathBuf::from("/tmp/wmux-name_with_space/wmux.sock")
        );
        assert!(endpoint.secure_parent);
        assert_eq!(
            unix_socket_path_from_env(None, None, None, Some("name with space".into())),
            endpoint.path
        );
    }

    #[test]
    fn windows_pipe_name_is_user_scoped_and_overridable() {
        assert_eq!(
            windows_pipe_name_from_env(None, None, Some("Jane Doe".into())),
            r"\\.\pipe\wmux-Jane_Doe"
        );
        assert_eq!(
            windows_pipe_name_from_env(
                Some(r"\\.\pipe\custom".into()),
                Some("dev-1".into()),
                Some("Jane".into()),
            ),
            r"\\.\pipe\custom"
        );
    }

    #[test]
    fn windows_pipe_name_uses_namespace_when_present() {
        assert_eq!(
            windows_pipe_name_from_env(None, Some("dev 1".into()), Some("Jane Doe".into())),
            r"\\.\pipe\wmux-Jane_Doe-dev_1"
        );
    }

    #[test]
    fn windows_mutex_name_is_derived_from_pipe_name() {
        assert_eq!(
            windows_mutex_name_from_pipe(r"\\.\pipe\wmux-Jane"),
            r"Local\____pipe_wmux-Jane-single-instance"
        );
    }
}
