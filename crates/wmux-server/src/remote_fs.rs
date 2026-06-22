//! Directory listing and file download over SSH.
//!
//! The browser file panel reads the wmux-server host's filesystem by default.
//! When the active workspace is a tmux/ssh session on a *different* host, these
//! run the listing/download on that host over the same SSH connection wmux
//! already uses for the session. No `--root` jail applies — the remote shell
//! runs as the connecting user and browses their own files.

use serde::Serialize;
use std::process::Stdio;
use wmux_core::command::apply_no_window;
use wmux_core::ssh_command::{quote_posix_shell_arg, SshCommand};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDir {
    pub path: String,
    pub entries: Vec<RemoteDirEntry>,
}

const SSH_OPTS: &[&str] = &[
    "-o",
    "ConnectTimeout=8",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
];

fn run(ssh: &SshCommand, remote_script: &str) -> Result<Vec<u8>, String> {
    let mut cmd = ssh.to_command_with_extra_options(SSH_OPTS);
    apply_no_window(&mut cmd);
    cmd.arg(remote_script);
    cmd.stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("ssh exec: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            format!("remote command failed ({})", out.status)
        } else {
            err.to_string()
        });
    }
    Ok(out.stdout)
}

/// List `path` on the remote host. Emits the canonical path first, then one
/// `type<TAB>size<TAB>name` line per entry. A single `ls -lLA | awk` instead of
/// a `stat`/`wc` per file: the latter forks once per entry, which on a large
/// directory is hundreds of ms of remote CPU on the SSH connection the terminal
/// shares — enough to stutter the terminal while the panel loads.
pub fn list_dir(ssh: &SshCommand, path: &str) -> Result<RemoteDir, String> {
    let p = quote_posix_shell_arg(path);
    let script = format!(
        "cd -- {p} 2>/dev/null || exit 3; pwd; \
         ls -lLA 2>/dev/null | awk 'NR>1 {{ \
           t=(substr($1,1,1)==\"d\")?\"d\":\"f\"; name=$0; \
           sub(/^([^ ]+ +){{8}}/,\"\",name); \
           if (name != \"\") printf \"%s\\t%s\\t%s\\n\", t, $5, name }}'"
    );
    let stdout = run(ssh, &script)?;
    let text = String::from_utf8_lossy(&stdout);
    let mut lines = text.lines();
    let canonical = lines
        .next()
        .map(|s| s.trim_end().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.to_string());

    let mut entries: Vec<RemoteDirEntry> = Vec::new();
    for line in lines {
        let mut parts = line.splitn(3, '\t');
        let kind = parts.next().unwrap_or("");
        let size = parts.next().unwrap_or("0").trim();
        let name = match parts.next() {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        entries.push(RemoteDirEntry {
            name: name.to_string(),
            is_dir: kind == "d",
            size: size.parse().unwrap_or(0),
            mtime: None,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(RemoteDir {
        path: canonical,
        entries,
    })
}

/// Fetch a remote file (raw bytes) or directory (`tar.gz`). Returns the download
/// filename and bytes. Probes the type first so the filename gets the right
/// extension.
pub fn download(ssh: &SshCommand, path: &str) -> Result<(String, Vec<u8>), String> {
    let base = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download")
        .to_string();
    let p = quote_posix_shell_arg(path);

    let probe = run(
        ssh,
        &format!("if [ -d {p} ]; then echo d; elif [ -e {p} ] || [ -L {p} ]; then echo f; else echo n; fi"),
    )?;
    match String::from_utf8_lossy(&probe).trim() {
        "d" => {
            let bytes = run(
                ssh,
                &format!("d={p}; tar -czf - -C \"$(dirname \"$d\")\" -- \"$(basename \"$d\")\""),
            )?;
            Ok((format!("{base}.tar.gz"), bytes))
        }
        "f" => {
            let bytes = run(ssh, &format!("cat -- {p}"))?;
            Ok((base, bytes))
        }
        _ => Err(format!("{path}: not found")),
    }
}
