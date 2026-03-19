use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Create a Command that doesn't show a console window on Windows
fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspaceInfo {
    pub cwd: String,
    pub git_branch: Option<String>,
    pub git_dirty: bool,
    pub ports: Vec<u16>,
}

/// Get current working directory of a process by PID
pub fn get_process_cwd(pid: u32) -> Option<String> {
    let output = silent_command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(Get-Process -Id {} -ErrorAction SilentlyContinue).Path | Split-Path -Parent", pid),
        ])
        .output()
        .ok()?;

    if output.status.success() {
        let cwd = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !cwd.is_empty() {
            return Some(cwd);
        }
    }
    None
}

/// Get git branch for a given directory
pub fn get_git_branch(dir: &str) -> Option<String> {
    let output = silent_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() {
            return Some(branch);
        }
    }
    None
}

/// Check if git repo has uncommitted changes
pub fn get_git_dirty(dir: &str) -> bool {
    let output = silent_command("git")
        .args(["status", "--porcelain"])
        .current_dir(dir)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            !String::from_utf8_lossy(&o.stdout).trim().is_empty()
        }
        _ => false,
    }
}

/// Get listening ports for a given PID using netstat
pub fn get_listening_ports(pid: u32) -> Vec<u16> {
    let output = silent_command("netstat")
        .args(["-ano", "-p", "TCP"])
        .output();

    let Ok(output) = output else { return vec![] };
    if !output.status.success() {
        return vec![];
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let pid_str = pid.to_string();
    let mut ports = Vec::new();

    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        // Format: TCP  0.0.0.0:PORT  0.0.0.0:0  LISTENING  PID
        if parts.len() >= 5
            && parts[3] == "LISTENING"
            && parts[4] == pid_str
        {
            if let Some(port_str) = parts[1].rsplit(':').next() {
                if let Ok(port) = port_str.parse::<u16>() {
                    ports.push(port);
                }
            }
        }
    }

    ports.sort();
    ports.dedup();
    ports
}

/// Shell context: SSH command + cwd for a given PTY process
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShellContext {
    pub ssh_command: Option<String>,
    pub cwd: Option<String>,
}

/// Get child processes of a given PID and detect SSH sessions
pub fn get_shell_context(pid: u32) -> ShellContext {
    // Use wmic to get child processes and their command lines
    let output = silent_command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                r#"Get-CimInstance Win32_Process | Where-Object {{ $_.ParentProcessId -eq {} }} | Select-Object ProcessId, Name, CommandLine | ForEach-Object {{ "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }}"#,
                pid
            ),
        ])
        .output();

    let Ok(output) = output else {
        return ShellContext::default();
    };

    if !output.status.success() {
        return ShellContext::default();
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut ssh_command = None;
    let mut cwd = None;

    for line in text.lines() {
        let parts: Vec<&str> = line.splitn(3, '|').collect();
        if parts.len() < 3 {
            continue;
        }
        let child_pid: u32 = match parts[0].trim().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let name = parts[1].trim().to_lowercase();
        let cmdline = parts[2].trim();

        // Detect SSH
        if name.contains("ssh") && !cmdline.is_empty() {
            ssh_command = Some(cmdline.to_string());
        }

        // Try to get cwd of the child process
        if cwd.is_none() {
            if let Some(dir) = get_process_cwd(child_pid) {
                cwd = Some(dir);
            }
        }
    }

    // If no child cwd found, try the shell process itself
    if cwd.is_none() {
        cwd = get_process_cwd(pid);
    }

    ShellContext { ssh_command, cwd }
}

/// Gather all info for a workspace given a directory path
pub fn gather_workspace_info(cwd: &str) -> WorkspaceInfo {
    let dir = if Path::new(cwd).exists() { cwd } else { "C:\\" };

    WorkspaceInfo {
        cwd: dir.to_string(),
        git_branch: get_git_branch(dir),
        git_dirty: get_git_dirty(dir),
        ports: vec![], // ports gathered separately per-PID
    }
}
