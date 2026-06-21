use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::command::silent_command;

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
    let _ = pid;
    // Windows does not expose another process's cwd through `Get-Process`.
    // Returning the executable directory is worse than returning nothing because
    // callers use this value for pane cwd cloning.
    None
}

#[cfg(target_os = "linux")]
pub fn get_process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
}

#[cfg(target_os = "macos")]
pub fn get_process_cwd(pid: u32) -> Option<String> {
    let output = silent_command("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_macos_lsof_cwd(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn get_process_cwd(pid: u32) -> Option<String> {
    let _ = pid;
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
        Ok(o) if o.status.success() => !String::from_utf8_lossy(&o.stdout).trim().is_empty(),
        _ => false,
    }
}

/// Get listening ports for a given PID using netstat (Windows) or ss (Linux)
#[cfg(windows)]
pub fn get_listening_ports(pid: u32) -> Vec<u16> {
    let pids: HashSet<u32> = std::iter::once(pid)
        .chain(get_descendant_pids(pid))
        .collect();
    let output = silent_command("netstat")
        .args(["-ano", "-p", "TCP"])
        .output();

    let Ok(output) = output else { return vec![] };
    if !output.status.success() {
        return vec![];
    }

    let text = String::from_utf8_lossy(&output.stdout);
    parse_windows_netstat_ports(&text, &pids)
}

#[cfg(target_os = "linux")]
pub fn get_listening_ports(pid: u32) -> Vec<u16> {
    let pids: HashSet<u32> = std::iter::once(pid)
        .chain(get_descendant_pids(pid))
        .collect();
    let output = silent_command("ss").args(["-tlnp"]).output();

    let Ok(output) = output else { return vec![] };
    if !output.status.success() {
        return vec![];
    }

    let text = String::from_utf8_lossy(&output.stdout);
    parse_linux_ss_ports(&text, &pids)
}

#[cfg(target_os = "macos")]
pub fn get_listening_ports(pid: u32) -> Vec<u16> {
    let mut pids: Vec<u32> = std::iter::once(pid)
        .chain(get_descendant_pids(pid))
        .collect();
    pids.sort();
    pids.dedup();
    let pid_csv = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let output = silent_command("lsof")
        .args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", &pid_csv])
        .output();

    let Ok(output) = output else { return vec![] };
    if !output.status.success() {
        return vec![];
    }

    parse_macos_lsof_ports(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn get_listening_ports(pid: u32) -> Vec<u16> {
    let _ = pid;
    Vec::new()
}

#[cfg(any(target_os = "linux", test))]
fn line_matches_any_pid(line: &str, pids: &HashSet<u32>) -> bool {
    pids.iter().any(|pid| {
        line.contains(&format!("pid={pid},"))
            || line.contains(&format!("pid={pid})"))
            || line.contains(&format!("pid={pid},"))
    })
}

#[cfg(any(windows, test))]
fn parse_windows_netstat_ports(text: &str, pids: &HashSet<u32>) -> Vec<u16> {
    let mut ports = Vec::new();

    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5
            && parts[0].eq_ignore_ascii_case("TCP")
            && parts[3].eq_ignore_ascii_case("LISTENING")
            && parts[4].parse::<u32>().is_ok_and(|pid| pids.contains(&pid))
        {
            if let Some(port) = parse_socket_port(parts[1]) {
                ports.push(port);
            }
        }
    }

    ports.sort();
    ports.dedup();
    ports
}

#[cfg(any(target_os = "linux", test))]
fn parse_linux_ss_ports(text: &str, pids: &HashSet<u32>) -> Vec<u16> {
    let mut ports = Vec::new();

    for line in text.lines() {
        if !line_matches_any_pid(line, pids) {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            if let Some(port) = parse_socket_port(parts[3]) {
                ports.push(port);
            }
        }
    }

    ports.sort();
    ports.dedup();
    ports
}

fn parse_socket_port(addr: &str) -> Option<u16> {
    addr.rsplit(':').next()?.trim_matches(']').parse().ok()
}

#[cfg(windows)]
fn get_descendant_pids(pid: u32) -> Vec<u32> {
    let output = silent_command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)\" }",
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let children_by_parent = parse_windows_process_parent_rows(&text);
    collect_descendants(pid, &children_by_parent)
}

#[cfg(target_os = "linux")]
fn get_descendant_pids(pid: u32) -> Vec<u32> {
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut queue = VecDeque::from([pid]);
    let mut seen = HashSet::new();

    while let Some(parent) = queue.pop_front() {
        if !seen.insert(parent) {
            continue;
        }
        for child in linux_child_pids(parent) {
            children_by_parent.entry(parent).or_default().push(child);
            queue.push_back(child);
        }
    }
    collect_descendants(pid, &children_by_parent)
}

#[cfg(target_os = "macos")]
fn get_descendant_pids(pid: u32) -> Vec<u32> {
    let output = silent_command("ps").args(["-axo", "pid=,ppid="]).output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let children_by_parent = parse_macos_process_parent_rows(&text);
    collect_descendants(pid, &children_by_parent)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn get_descendant_pids(pid: u32) -> Vec<u32> {
    let _ = pid;
    Vec::new()
}

#[cfg(target_os = "linux")]
fn linux_child_pids(pid: u32) -> Vec<u32> {
    let text =
        std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")).unwrap_or_default();
    parse_linux_child_pids(&text)
}

#[cfg(any(windows, test))]
fn parse_windows_process_parent_rows(text: &str) -> HashMap<u32, Vec<u32>> {
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let Some((child, parent)) = line.split_once('|') else {
            continue;
        };
        let Ok(child) = child.trim().parse::<u32>() else {
            continue;
        };
        let Ok(parent) = parent.trim().parse::<u32>() else {
            continue;
        };
        children_by_parent.entry(parent).or_default().push(child);
    }
    children_by_parent
}

#[cfg(any(target_os = "linux", test))]
fn parse_linux_child_pids(text: &str) -> Vec<u32> {
    text.split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect()
}

#[cfg(any(target_os = "macos", test))]
#[allow(dead_code)]
fn parse_macos_process_parent_rows(text: &str) -> HashMap<u32, Vec<u32>> {
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(child) = parts.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(parent) = parts.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        children_by_parent.entry(parent).or_default().push(child);
    }
    children_by_parent
}

fn collect_descendants(pid: u32, children_by_parent: &HashMap<u32, Vec<u32>>) -> Vec<u32> {
    let mut out = Vec::new();
    let mut queue = VecDeque::new();
    if let Some(children) = children_by_parent.get(&pid) {
        queue.extend(children.iter().copied());
    }
    while let Some(child) = queue.pop_front() {
        if out.contains(&child) {
            continue;
        }
        out.push(child);
        if let Some(children) = children_by_parent.get(&child) {
            queue.extend(children.iter().copied());
        }
    }
    out
}

pub fn collect_session_metadata(pid: u32, fallback_cwd: Option<String>) -> SessionMetadata {
    let system = shared_process_system();
    let descendant_pids = collect_sysinfo_descendant_pids(&system, pid);
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

pub fn process_tree_contains_agent(pid: u32, agent: &str) -> bool {
    let agent = match normalize_process_name(agent).as_str() {
        "codex" => "codex",
        "claude" => "claude",
        _ => return false,
    };
    let system = shared_process_system();
    collect_sysinfo_descendant_pids(&system, pid)
        .iter()
        .filter_map(|p| system.process(sysinfo_crate::Pid::from_u32(*p)))
        .any(|process| {
            let name = process_display_name(process).unwrap_or_default();
            let command = command_line(process);
            detect_agent(&name, command.as_deref()) == Some(agent)
        })
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

/// Returns a process snapshot reused across calls within a short TTL. The
/// metadata poller fires one `get_session_metadata` per workspace in parallel
/// every few seconds; without this each call did its own full process refresh.
/// Concurrent callers in the same tick now share a single refresh.
fn shared_process_system() -> Arc<sysinfo_crate::System> {
    const TTL: Duration = Duration::from_millis(200);
    static CACHE: Mutex<Option<(Instant, Arc<sysinfo_crate::System>)>> = Mutex::new(None);

    let mut guard = CACHE.lock().unwrap();
    if let Some((at, sys)) = guard.as_ref() {
        if at.elapsed() < TTL {
            return Arc::clone(sys);
        }
    }
    let sys = Arc::new(new_process_system());
    *guard = Some((Instant::now(), Arc::clone(&sys)));
    sys
}

fn collect_sysinfo_descendant_pids(system: &sysinfo_crate::System, root: u32) -> HashSet<u32> {
    // Build a parent -> children index once, then walk it from the root. The
    // previous fixed-point loop re-scanned every process on each pass (O(n²)).
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }

    let mut pids = HashSet::from([root]);
    let mut queue = VecDeque::from([root]);
    while let Some(current) = queue.pop_front() {
        if let Some(kids) = children.get(&current) {
            for &child in kids {
                if pids.insert(child) {
                    queue.push_back(child);
                }
            }
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

#[cfg(windows)]
fn process_cwd(process: &sysinfo_crate::Process) -> Option<String> {
    // sysinfo reads the process's Win32 current directory from the PEB. PowerShell's
    // `Set-Location` (cd) does not update that — it only moves the provider $PWD — so
    // the PEB keeps reporting the launch directory and would clobber the accurate cwd
    // the shell hook reports via OSC 7. Defer to the frontend-provided cwd instead,
    // matching get_process_cwd's Windows policy.
    let _ = process;
    None
}

#[cfg(not(windows))]
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

#[cfg(target_os = "linux")]
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
            let cmdline = parse_linux_cmdline(&raw);

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

#[cfg(any(target_os = "linux", test))]
fn parse_linux_cmdline(raw: &[u8]) -> String {
    raw.split(|&b| b == 0)
        .map(|part| String::from_utf8_lossy(part).to_string())
        .filter(|s| !s.is_empty())
        .map(|s| shell_quote_arg(&s))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(any(target_os = "linux", test))]
fn shell_quote_arg(value: &str) -> String {
    if !value.is_empty()
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '-' | '.' | '/' | ':' | '@' | '%' | '+' | '=')
        })
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_lsof_cwd(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix('n'))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_lsof_ports(text: &str) -> Vec<u16> {
    let mut ports = Vec::new();
    for line in text.lines() {
        if !line.contains("(LISTEN)") {
            continue;
        }
        let Some(tcp_part) = line.split("TCP ").nth(1) else {
            continue;
        };
        let addr = tcp_part.split_whitespace().next().unwrap_or("");
        if let Some(port) = parse_socket_port(addr) {
            ports.push(port);
        }
    }
    ports.sort();
    ports.dedup();
    ports
}

#[cfg(target_os = "macos")]
pub fn get_shell_context(pid: u32) -> ShellContext {
    let output = silent_command("ps")
        .args(["-axo", "pid=,ppid=,command="])
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
    for (child_pid, command) in parse_macos_child_commands(&text, pid) {
        if ssh_command.is_none() && command.contains("ssh") {
            ssh_command = Some(command);
        }
        if cwd.is_none() {
            cwd = get_process_cwd(child_pid);
        }
    }
    if cwd.is_none() {
        cwd = get_process_cwd(pid);
    }
    ShellContext { ssh_command, cwd }
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_child_commands(text: &str, parent_pid: u32) -> Vec<(u32, String)> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let child = parts.next()?.parse::<u32>().ok()?;
            let parent = parts.next()?.parse::<u32>().ok()?;
            let command = parts.collect::<Vec<_>>().join(" ");
            (parent == parent_pid && !command.is_empty()).then_some((child, command))
        })
        .collect()
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn get_shell_context(pid: u32) -> ShellContext {
    let _ = pid;
    ShellContext::default()
}

/// Gather all info for a workspace given a directory path
pub fn gather_workspace_info(cwd: &str) -> WorkspaceInfo {
    let fallback = if cfg!(windows) { "C:\\" } else { "/" };
    let dir = if Path::new(cwd).exists() {
        cwd
    } else {
        fallback
    };

    WorkspaceInfo {
        cwd: dir.to_string(),
        git_branch: get_git_branch(dir),
        git_dirty: get_git_dirty(dir),
        ports: vec![], // ports gathered separately per-PID
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_descendants_walks_tree() {
        let mut map = HashMap::new();
        map.insert(1, vec![2, 3]);
        map.insert(2, vec![4]);
        assert_eq!(collect_descendants(1, &map), vec![2, 3, 4]);
    }

    #[test]
    fn ss_line_matches_descendant_pid() {
        let pids = HashSet::from([10, 42]);
        assert!(line_matches_any_pid(
            "users:((\"node\",pid=42,fd=18))",
            &pids
        ));
        assert!(!line_matches_any_pid(
            "users:((\"node\",pid=99,fd=18))",
            &pids
        ));
    }

    #[test]
    fn parse_linux_ss_ports_matches_descendant_pids() {
        let pids = HashSet::from([42]);
        let text = "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n\
                    LISTEN 0      4096       127.0.0.1:5173      0.0.0.0:* users:((\"node\",pid=42,fd=18))\n\
                    LISTEN 0      4096       127.0.0.1:9999      0.0.0.0:* users:((\"node\",pid=77,fd=18))";
        assert_eq!(parse_linux_ss_ports(text, &pids), vec![5173]);
    }

    #[test]
    fn parse_windows_netstat_ports_matches_descendant_pids() {
        let pids = HashSet::from([1234]);
        let text = "\
            Proto  Local Address          Foreign Address        State           PID\n\
            TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234\n\
            TCP    0.0.0.0:9000           0.0.0.0:0              LISTENING       9999";
        assert_eq!(parse_windows_netstat_ports(text, &pids), vec![3000]);
    }

    #[test]
    fn parse_windows_process_parent_rows_ignores_invalid_lines() {
        let map = parse_windows_process_parent_rows("2|1\nbad\n3|1\n4|2\n");
        assert_eq!(collect_descendants(1, &map), vec![2, 3, 4]);
    }

    #[test]
    fn parse_linux_child_pids_ignores_invalid_tokens() {
        assert_eq!(parse_linux_child_pids("2 nope 3\n4"), vec![2, 3, 4]);
    }

    #[test]
    fn parse_linux_cmdline_quotes_nul_separated_args() {
        let raw = [
            b's', b's', b'h', 0, b'-', b'p', 0, b'2', b'2', b'2', b'2', 0, b'm', b'e', b'@', b'h',
            b'o', b's', b't', 0,
        ];
        assert_eq!(parse_linux_cmdline(&raw), "ssh -p 2222 me@host");
    }

    #[test]
    fn parse_linux_cmdline_preserves_args_with_spaces() {
        let raw = b"ssh\0-i\0/home/me/work key\0me@host\0";
        assert_eq!(
            parse_linux_cmdline(raw),
            "ssh -i '/home/me/work key' me@host"
        );
    }

    #[test]
    fn detect_agent_matches_codex_binary_and_node_wrapper_commands() {
        assert_eq!(detect_agent("codex", None), Some("codex"));
        assert_eq!(
            detect_agent(
                "node",
                Some("/home/me/.nvm/versions/node/bin/node /home/me/.npm/bin/codex.js")
            ),
            Some("codex")
        );
        assert_eq!(detect_agent("bash", Some("echo codec")), None);
    }

    #[test]
    fn parse_macos_lsof_cwd_extracts_name_record() {
        assert_eq!(
            parse_macos_lsof_cwd("p123\nn/Users/me/project\n"),
            Some("/Users/me/project".to_string())
        );
    }

    #[test]
    fn parse_macos_lsof_ports_extracts_listeners() {
        let text = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n\
                   node 123 me 10u IPv4 0 0t0 TCP 127.0.0.1:5173 (LISTEN)\n\
                   node 123 me 11u IPv6 0 0t0 TCP *:8080 (LISTEN)\n";
        assert_eq!(parse_macos_lsof_ports(text), vec![5173, 8080]);
    }

    #[test]
    fn parse_macos_child_commands_keeps_command_tail() {
        let rows = "101 1 /bin/zsh\n202 101 ssh -i /tmp/key me@host\n";
        assert_eq!(
            parse_macos_child_commands(rows, 101),
            vec![(202, "ssh -i /tmp/key me@host".to_string())]
        );
    }
}
