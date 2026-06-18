use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Create a Command that doesn't show a console window on Windows
fn silent_command(program: &str) -> Command {
    #[allow(unused_mut)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionMetadata {
    pub cwd: String,
    pub git_branch: Option<String>,
    pub git_dirty: bool,
    pub ports: Vec<u16>,
    pub process_name: Option<String>,
    pub command: Option<String>,
    pub agent: Option<String>,
    pub memory_bytes: u64,
    pub cpu_percent: f32,
    pub descendant_count: usize,
}

/// Get current working directory of a process by PID
#[cfg(windows)]
pub fn get_process_cwd(pid: u32) -> Option<String> {
    let output = silent_command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "(Get-Process -Id {} -ErrorAction SilentlyContinue).Path | Split-Path -Parent",
                pid
            ),
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

#[cfg(unix)]
pub fn get_process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
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
        Ok(o) if o.status.success() => !String::from_utf8_lossy(&o.stdout).trim().is_empty(),
        _ => false,
    }
}

/// Get listening ports for a given PID using netstat (Windows) or ss (Linux)
#[cfg(windows)]
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
        if parts.len() >= 5 && parts[3] == "LISTENING" && parts[4] == pid_str {
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

#[cfg(unix)]
pub fn get_listening_ports(pid: u32) -> Vec<u16> {
    // ss -tlnp: TCP listening sockets with process info
    let output = Command::new("ss").args(["-tlnp"]).output();

    let Ok(output) = output else { return vec![] };
    if !output.status.success() {
        return vec![];
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let pid_pattern = format!("pid={pid},");
    let pid_pattern2 = format!("pid={pid})");
    let mut ports = Vec::new();

    for line in text.lines() {
        // Match lines containing our PID
        if !line.contains(&pid_pattern) && !line.contains(&pid_pattern2) {
            continue;
        }
        // Format: State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            // Local Address:Port is at index 3
            if let Some(port_str) = parts[3].rsplit(':').next() {
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

pub fn collect_session_metadata(pid: u32, fallback_cwd: Option<String>) -> SessionMetadata {
    let system = new_process_system();
    let descendant_pids = collect_descendant_pids(&system, pid);
    let representative_pid = pick_representative_pid(&system, &descendant_pids, pid);
    let representative = representative_pid.and_then(|p| system.process(p));
    let root_process = system.process(sysinfo_crate::Pid::from_u32(pid));

    let cwd = representative
        .and_then(process_cwd)
        .or_else(|| root_process.and_then(process_cwd))
        .or(fallback_cwd)
        .unwrap_or_else(default_cwd);

    let workspace_info = gather_workspace_info(&cwd);
    let representative_name = representative.and_then(process_display_name);
    let command = representative.and_then(command_line);
    let agent = detect_agent(
        representative_name.as_deref().unwrap_or_default(),
        command.as_deref(),
    )
    .map(str::to_string);
    let ports = get_descendant_listening_ports(&descendant_pids);

    let mut memory_bytes = 0;
    let mut cpu_percent = 0.0;
    for p in descendant_pids
        .iter()
        .filter_map(|p| system.process(sysinfo_crate::Pid::from_u32(*p)))
    {
        memory_bytes += p.memory();
        cpu_percent += p.cpu_usage();
    }

    SessionMetadata {
        cwd: workspace_info.cwd,
        git_branch: workspace_info.git_branch,
        git_dirty: workspace_info.git_dirty,
        ports,
        process_name: representative_name,
        command,
        agent,
        memory_bytes,
        cpu_percent,
        descendant_count: descendant_pids.len(),
    }
}

fn new_process_system() -> sysinfo_crate::System {
    let mut system = sysinfo_crate::System::new();
    system.refresh_processes_specifics(
        sysinfo_crate::ProcessesToUpdate::All,
        true,
        sysinfo_crate::ProcessRefreshKind::everything().without_tasks(),
    );
    system
}

fn collect_descendant_pids(system: &sysinfo_crate::System, root: u32) -> HashSet<u32> {
    let mut pids = HashSet::from([root]);
    loop {
        let mut changed = false;
        for (pid, process) in system.processes() {
            let child = pid.as_u32();
            if pids.contains(&child) {
                continue;
            }
            if process
                .parent()
                .map(|parent| pids.contains(&parent.as_u32()))
                .unwrap_or(false)
            {
                pids.insert(child);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    pids
}

fn pick_representative_pid(
    system: &sysinfo_crate::System,
    pids: &HashSet<u32>,
    root: u32,
) -> Option<sysinfo_crate::Pid> {
    pids.iter()
        .filter_map(|pid| {
            let spid = sysinfo_crate::Pid::from_u32(*pid);
            let process = system.process(spid)?;
            let name = process_display_name(process).unwrap_or_default();
            let command = command_line(process);
            let score = process_score(&name, command.as_deref(), *pid == root);
            Some((score, process.memory(), process.start_time(), spid))
        })
        .max_by_key(|(score, memory, start_time, _)| (*score, *memory, *start_time))
        .map(|(_, _, _, pid)| pid)
}

fn process_score(name: &str, command: Option<&str>, is_root: bool) -> i32 {
    if detect_agent(name, command).is_some() {
        return 1000;
    }

    let lower = normalize_process_name(name);
    if is_shell_process(&lower) {
        return if is_root { 10 } else { 20 };
    }

    if matches!(
        lower.as_str(),
        "node" | "bun" | "deno" | "cargo" | "rustc" | "python" | "python3" | "go" | "java"
    ) {
        return 500;
    }

    if is_root {
        100
    } else {
        200
    }
}

fn detect_agent(name: &str, command: Option<&str>) -> Option<&'static str> {
    for agent in ["codex", "claude", "gemini", "copilot"] {
        if process_token_matches(name, agent)
            || command
                .map(|cmd| process_token_matches(cmd, agent))
                .unwrap_or(false)
        {
            return Some(agent);
        }
    }
    None
}

fn process_token_matches(value: &str, needle: &str) -> bool {
    value
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .any(|part| normalize_process_name(part) == needle)
}

fn process_display_name(process: &sysinfo_crate::Process) -> Option<String> {
    let name = process.name().to_string_lossy().trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn command_line(process: &sysinfo_crate::Process) -> Option<String> {
    let parts: Vec<String> = process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy().to_string())
        .filter(|part| !part.trim().is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn process_cwd(process: &sysinfo_crate::Process) -> Option<String> {
    process
        .cwd()
        .and_then(|path| path.to_str())
        .map(str::to_string)
        .filter(|cwd| !cwd.is_empty())
}

fn normalize_process_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    lower
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&lower)
        .trim_end_matches(".exe")
        .to_string()
}

fn is_shell_process(name: &str) -> bool {
    matches!(
        name,
        "sh" | "bash"
            | "zsh"
            | "fish"
            | "nu"
            | "cmd"
            | "powershell"
            | "pwsh"
            | "ssh"
            | "tmux"
            | "login"
            | "wmux"
            | "wmux-cli"
    )
}

fn get_descendant_listening_ports(pids: &HashSet<u32>) -> Vec<u16> {
    if !listeners::IS_OS_SUPPORTED {
        return vec![];
    }

    let Ok(listeners) = listeners::get_all() else {
        return vec![];
    };

    let mut ports: Vec<u16> = listeners
        .into_iter()
        .filter(|listener| {
            pids.contains(&listener.process.pid)
                && listener.protocol == listeners::Protocol::TCP
                && listener.state == listeners::SocketState::Listen
        })
        .map(|listener| listener.socket.port())
        .collect();
    ports.sort();
    ports.dedup();
    ports
}

fn default_cwd() -> String {
    if cfg!(windows) {
        "C:\\".to_string()
    } else {
        "/".to_string()
    }
}

/// Shell context: SSH command + cwd for a given PTY process
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShellContext {
    pub ssh_command: Option<String>,
    pub cwd: Option<String>,
}

/// Get child processes of a given PID and detect SSH sessions
#[cfg(windows)]
pub fn get_shell_context(pid: u32) -> ShellContext {
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

#[cfg(unix)]
pub fn get_shell_context(pid: u32) -> ShellContext {
    let mut ssh_command = None;
    let mut cwd = None;

    // Read child PIDs from /proc/{pid}/task/{pid}/children
    let children_path = format!("/proc/{pid}/task/{pid}/children");
    let child_pids: Vec<u32> = std::fs::read_to_string(&children_path)
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();

    for child_pid in &child_pids {
        // Read cmdline
        let cmdline_path = format!("/proc/{child_pid}/cmdline");
        if let Ok(raw) = std::fs::read(&cmdline_path) {
            let cmdline = raw
                .split(|&b| b == 0)
                .map(|part| String::from_utf8_lossy(part).to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");

            // Detect SSH
            if cmdline.contains("ssh") && ssh_command.is_none() {
                ssh_command = Some(cmdline);
            }
        }

        // Try to get cwd of the child process
        if cwd.is_none() {
            cwd = get_process_cwd(*child_pid);
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
    let fallback = default_cwd();
    let dir = if Path::new(cwd).exists() {
        cwd
    } else {
        &fallback
    };

    WorkspaceInfo {
        cwd: dir.to_string(),
        git_branch: get_git_branch(dir),
        git_dirty: get_git_dirty(dir),
        ports: vec![], // ports gathered separately per-PID
    }
}
