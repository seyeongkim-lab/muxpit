use crate::platform::command::silent_command;
use crate::ssh_command::{quote_posix_shell_arg, SshCommand};
use serde::Serialize;
use std::fs;
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
