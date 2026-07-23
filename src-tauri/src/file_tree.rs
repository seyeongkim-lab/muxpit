use crate::platform::command::silent_command;
use crate::ssh_command::{quote_posix_shell_arg, SshCommand};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<DirEntry>,
}

const SSH_OPTS: &[&str] = &[
    "-o",
    "ConnectTimeout=8",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
];

pub fn list_local_dir(path: Option<&str>) -> Result<DirListing, String> {
    let requested = path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let canonical = requested
        .canonicalize()
        .unwrap_or_else(|_| requested.clone());
    let mut entries = Vec::new();

    let iter = fs::read_dir(&canonical).map_err(|err| format!("{}: {err}", canonical.display()))?;
    for item in iter {
        let item = item.map_err(|err| err.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        let metadata = item.metadata().map_err(|err| format!("{name}: {err}"))?;
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs());
        entries.push(DirEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            mtime,
        });
    }

    sort_entries(&mut entries);
    Ok(DirListing {
        path: canonical.display().to_string(),
        entries,
    })
}

pub fn list_remote_dir(ssh: &SshCommand, path: &str) -> Result<DirListing, String> {
    let requested = if path.trim().is_empty() {
        "."
    } else {
        path.trim()
    };
    let quoted = quote_posix_shell_arg(requested);
    let script = format!(
        "cd -- {quoted} 2>/dev/null || exit 3; pwd; \
         ls -lLA 2>/dev/null | awk 'NR>1 {{ \
           t=(substr($1,1,1)==\"d\")?\"d\":\"f\"; name=$0; \
           sub(/^([^ ]+ +){{8}}/,\"\",name); \
           if (name != \"\") printf \"%s\\t%s\\t%s\\n\", t, $5, name }}'"
    );
    let output = run_remote(ssh, &script)?;
    let text = String::from_utf8_lossy(&output);
    let mut lines = text.lines();
    let canonical = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(requested)
        .to_string();
    let mut entries = Vec::new();

    for line in lines {
        let mut parts = line.splitn(3, '\t');
        let kind = parts.next().unwrap_or("");
        let size = parts.next().unwrap_or("0").trim();
        let name = match parts.next() {
            Some(value) if !value.is_empty() => value,
            _ => continue,
        };
        entries.push(DirEntry {
            name: name.to_string(),
            is_dir: kind == "d",
            size: size.parse().unwrap_or(0),
            mtime: None,
        });
    }

    sort_entries(&mut entries);
    Ok(DirListing {
        path: canonical,
        entries,
    })
}

/// Viewer payloads are capped so a stray multi-gigabyte log cannot stall the
/// UI or the SSH link; the flag lets the viewer say the tail was cut.
const FILE_READ_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
}

fn file_content(path: String, size: u64, bytes: &[u8]) -> FileContent {
    let truncated = bytes.len() > FILE_READ_LIMIT;
    let bytes = &bytes[..bytes.len().min(FILE_READ_LIMIT)];
    let binary = bytes.contains(&0);
    FileContent {
        path,
        content: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        },
        size,
        truncated,
        binary,
    }
}

fn expand_local_home(path: &str) -> Option<PathBuf> {
    let rest = path
        .strip_prefix("~/")
        .or_else(|| path.strip_prefix("~\\"))?;
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(rest))
}

pub fn read_local_file(path: &str, cwd: Option<&str>) -> Result<FileContent, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("File path is empty".to_string());
    }
    let mut resolved = expand_local_home(trimmed).unwrap_or_else(|| PathBuf::from(trimmed));
    if resolved.is_relative() {
        if let Some(base) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
            resolved = PathBuf::from(base).join(resolved);
        }
    }
    let file = fs::File::open(&resolved).map_err(|err| format!("{}: {err}", resolved.display()))?;
    let size = file
        .metadata()
        .map_err(|err| format!("{}: {err}", resolved.display()))?
        .len();
    let mut bytes = Vec::new();
    file.take((FILE_READ_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("{}: {err}", resolved.display()))?;
    let display = resolved
        .canonicalize()
        .unwrap_or(resolved)
        .display()
        .to_string();
    Ok(file_content(display, size, &bytes))
}

/// Quote a remote path while keeping a leading `~/` meaningful: the tilde is
/// rewritten to `$HOME` outside the quotes so the shell resolves it.
fn quote_remote_path(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", quote_posix_shell_arg(rest)),
        None => quote_posix_shell_arg(path),
    }
}

pub fn read_remote_file(
    ssh: &SshCommand,
    path: &str,
    cwd: Option<&str>,
) -> Result<FileContent, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("File path is empty".to_string());
    }
    // Only relative paths need the session cwd; when the cwd itself is gone,
    // failing beats silently resolving against the SSH login's home directory.
    let cd = if trimmed.starts_with('/') || trimmed.starts_with('~') {
        String::new()
    } else {
        cwd.map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                format!(
                    "cd -- {} 2>/dev/null || {{ echo 'Session directory is not accessible' >&2; exit 3; }}; ",
                    quote_remote_path(value),
                )
            })
            .unwrap_or_default()
    };
    // First line is the byte size; the rest is the (possibly truncated) body.
    // One extra byte is requested so truncation is detectable even when the
    // remote stat and read race a growing file.
    let script = format!(
        "{cd}p={}; wc -c < \"$p\" && head -c {} \"$p\"",
        quote_remote_path(trimmed),
        FILE_READ_LIMIT + 1,
    );
    let output = run_remote(ssh, &script)?;
    let newline = output
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| "Unexpected remote read output".to_string())?;
    let size: u64 = String::from_utf8_lossy(&output[..newline])
        .trim()
        .parse()
        .map_err(|_| "Unexpected remote read output".to_string())?;
    Ok(file_content(trimmed.to_string(), size, &output[newline + 1..]))
}

fn run_remote(ssh: &SshCommand, remote_script: &str) -> Result<Vec<u8>, String> {
    let mut cmd = silent_command(&ssh.program);
    cmd.args(&ssh.options);
    cmd.args(SSH_OPTS);
    cmd.arg(&ssh.target);
    cmd.arg(remote_script);
    cmd.stderr(Stdio::piped());

    let output = cmd.output().map_err(|err| format!("ssh exec: {err}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr.trim();
    Err(if message.is_empty() {
        format!("remote read failed ({})", output.status)
    } else {
        message.to_string()
    })
}

fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_body_is_cut_and_flagged() {
        let bytes = vec![b'a'; FILE_READ_LIMIT + 1];
        let content = file_content("big.log".into(), bytes.len() as u64, &bytes);

        assert!(content.truncated);
        assert_eq!(content.content.len(), FILE_READ_LIMIT);
        assert!(!content.binary);
    }

    #[test]
    fn null_bytes_mark_the_file_binary_without_shipping_content() {
        let content = file_content("app.bin".into(), 4, b"a\0bc");

        assert!(content.binary);
        assert_eq!(content.content, "");
    }

    #[test]
    fn remote_tilde_path_resolves_via_home_outside_quotes() {
        assert_eq!(quote_remote_path("~/notes/plan.md"), "\"$HOME\"/'notes/plan.md'");
        assert_eq!(quote_remote_path("/var/log/syslog"), "'/var/log/syslog'");
    }
}
