use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub user: String,
    pub cpu: f64,
    pub mem: f64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetInfo {
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorData {
    pub monitor_id: String,
    pub cpu_percent: f64,
    pub mem_total_mb: u64,
    pub mem_used_mb: u64,
    pub mem_percent: f64,
    pub load_avg: [f64; 3],
    pub processes: Vec<ProcessInfo>,
    pub hostname: String,
    pub timestamp: u64,
    pub error: Option<String>,
    pub net: Option<NetInfo>,
    pub disks: Vec<DiskInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub mount: String,
    pub total_gb: f64,
    pub used_gb: f64,
    pub percent: f64,
}

#[derive(Clone, Default)]
struct NetSnapshot {
    rx_bytes: u64,
    tx_bytes: u64,
    timestamp_ms: u64,
}

struct MonitorSession {
    stop_flag: Arc<Mutex<bool>>,
}

pub struct MonitorManager {
    sessions: Mutex<HashMap<String, MonitorSession>>,
}

impl MonitorManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn start(&self, app: AppHandle, monitor_id: String, ssh_target: String) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();

        // Stop existing session with same ID
        if let Some(existing) = sessions.remove(&monitor_id) {
            *existing.stop_flag.lock().unwrap() = true;
        }

        let stop_flag = Arc::new(Mutex::new(false));
        let stop_flag_clone = stop_flag.clone();
        let mid = monitor_id.clone();

        sessions.insert(monitor_id, MonitorSession { stop_flag });

        // Spawn persistent SSH connection thread
        std::thread::spawn(move || {
            run_persistent_monitor(&app, &ssh_target, &mid, &stop_flag_clone);
        });

        Ok(())
    }

    pub fn stop(&self, monitor_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(monitor_id) {
            *session.stop_flag.lock().unwrap() = true;
            Ok(())
        } else {
            Err(format!("Monitor session '{monitor_id}' not found"))
        }
    }
}

unsafe impl Send for MonitorManager {}
unsafe impl Sync for MonitorManager {}

// The collection script sent every tick. Ends with a unique marker.
const END_MARKER: &str = "===WMUX_END===";

fn build_collect_script() -> String {
    format!(
        r#"OS=$(uname -s); echo "===OS===$OS"; if [ "$OS" = "Darwin" ]; then echo '===CPU===' && top -l 1 -n 0 -s 0 2>/dev/null | grep 'CPU usage' && echo '===MEM===' && vm_stat 2>/dev/null && echo "===MEMTOTAL===$(sysctl -n hw.memsize 2>/dev/null)" && echo '===LOAD===' && sysctl -n vm.loadavg 2>/dev/null && echo '===NET===' && netstat -ib 2>/dev/null | head -20 && echo '===DISK===' && df -h 2>/dev/null | grep '^/dev/' && echo '===PS===' && ps aux -r 2>/dev/null | head -11 && echo '===HOST===' && hostname; else echo '===STAT===' && head -1 /proc/stat && echo '===MEM===' && head -5 /proc/meminfo && echo '===LOAD===' && cat /proc/loadavg && echo '===NET===' && cat /proc/net/dev && echo '===DISK===' && df -h -x tmpfs -x squashfs -x devtmpfs -x overlay -x efivarfs 2>/dev/null | tail -n +2 && echo '===PS===' && ps aux --sort=-%cpu 2>/dev/null | head -11 && echo '===HOST===' && hostname -f 2>/dev/null || hostname; fi; echo '{END_MARKER}'"#,
        END_MARKER = END_MARKER,
    )
}

/// Run a persistent SSH session, sending collection commands every 1 second
fn run_persistent_monitor(app: &AppHandle, ssh_target: &str, monitor_id: &str, stop_flag: &Arc<Mutex<bool>>) {
    let mut prev_cpu: Option<CpuSnapshot> = None;
    let mut prev_net: Option<NetSnapshot> = None;

    loop {
        if *stop_flag.lock().unwrap() {
            return;
        }

        // Spawn persistent SSH process
        let mut cmd = Command::new("ssh");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.args([
            "-T", // No PTY allocation
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=10",
            "-o", "ServerAliveCountMax=3",
            ssh_target,
        ]);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("monitor-data", &error_data(monitor_id, &format!("SSH spawn failed: {e}")));
                // Wait before retry
                sleep_with_stop(5000, stop_flag);
                continue;
            }
        };

        let mut stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                let _ = app.emit("monitor-data", &error_data(monitor_id, "Failed to get SSH stdin"));
                sleep_with_stop(5000, stop_flag);
                continue;
            }
        };

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                let _ = app.emit("monitor-data", &error_data(monitor_id, "Failed to get SSH stdout"));
                sleep_with_stop(5000, stop_flag);
                continue;
            }
        };

        let reader = BufReader::new(stdout);
        let reader = Arc::new(Mutex::new(reader));
        let script = build_collect_script();

        // Collection loop on this SSH connection
        loop {
            if *stop_flag.lock().unwrap() {
                let _ = child.kill();
                return;
            }

            // Send collection command
            if writeln!(stdin, "{}", script).is_err() || stdin.flush().is_err() {
                // SSH connection broken, break to reconnect
                break;
            }

            // Read until END_MARKER
            let mut output = String::new();
            let ok = {
                let mut rdr = reader.lock().unwrap();
                loop {
                    let mut line = String::new();
                    match rdr.read_line(&mut line) {
                        Ok(0) => break false, // EOF — connection closed
                        Ok(_) => {
                            if line.trim() == END_MARKER {
                                break true;
                            }
                            output.push_str(&line);
                        }
                        Err(_) => break false,
                    }
                }
            };

            if !ok {
                // Connection lost, break to reconnect
                break;
            }

            let data = parse_remote_output(&output, monitor_id, &mut prev_cpu, &mut prev_net);
            let _ = app.emit("monitor-data", &data);

            // Sleep 1 second, checking stop flag every 250ms
            for _ in 0..4 {
                if *stop_flag.lock().unwrap() {
                    let _ = child.kill();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }

        // Clean up broken connection
        let _ = child.kill();
        let _ = child.wait();

        // Emit error and wait before reconnecting
        let _ = app.emit("monitor-data", &error_data(monitor_id, "SSH connection lost, reconnecting..."));
        if !sleep_with_stop(3000, stop_flag) {
            return;
        }
    }
}

/// Sleep for `ms` milliseconds, checking stop_flag every 250ms. Returns false if stopped.
fn sleep_with_stop(ms: u64, stop_flag: &Arc<Mutex<bool>>) -> bool {
    let ticks = ms / 250;
    for _ in 0..ticks {
        if *stop_flag.lock().unwrap() {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    true
}

// ── Parsing ──────────────────────────────────────────────────────────────

#[derive(Clone)]
struct CpuSnapshot {
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    irq: u64,
    softirq: u64,
    steal: u64,
}

impl CpuSnapshot {
    fn total(&self) -> u64 {
        self.user + self.nice + self.system + self.idle + self.iowait + self.irq + self.softirq + self.steal
    }
    fn busy(&self) -> u64 {
        self.total() - self.idle - self.iowait
    }
}

fn parse_remote_output(text: &str, monitor_id: &str, prev_cpu: &mut Option<CpuSnapshot>, prev_net: &mut Option<NetSnapshot>) -> MonitorData {
    let sections = split_sections(text);
    let is_macos = sections.get("OS").map(|s| s.trim() == "Darwin").unwrap_or(false);

    let (cpu_percent, mem_total_mb, mem_used_mb, mem_percent, load_avg, processes) = if is_macos {
        let cpu = sections.get("CPU").map(|s| parse_macos_cpu(s)).unwrap_or(0.0);
        let (total, used, pct) = if let Some(mem) = sections.get("MEM") {
            let total_bytes: u64 = sections.get("MEMTOTAL")
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            parse_macos_mem(mem, total_bytes)
        } else {
            (0, 0, 0.0)
        };
        let load = sections.get("LOAD").map(|s| parse_macos_loadavg(s)).unwrap_or([0.0; 3]);
        let procs = sections.get("PS").map(|s| parse_ps(s)).unwrap_or_default();
        (cpu, total, used, pct, load, procs)
    } else {
        let cpu = sections.get("STAT").map(|s| parse_cpu(s, prev_cpu)).unwrap_or(0.0);
        let (total, used, pct) = sections.get("MEM").map(|s| parse_meminfo(s)).unwrap_or((0, 0, 0.0));
        let load = sections.get("LOAD").map(|s| parse_loadavg(s)).unwrap_or([0.0; 3]);
        let procs = sections.get("PS").map(|s| parse_ps(s)).unwrap_or_default();
        (cpu, total, used, pct, load, procs)
    };

    // Network
    let net = if let Some(net_text) = sections.get("NET") {
        let (rx, tx) = if is_macos { parse_macos_net(net_text) } else { parse_linux_net(net_text) };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let current = NetSnapshot { rx_bytes: rx, tx_bytes: tx, timestamp_ms: now_ms };
        let info = if let Some(ref prev) = prev_net {
            let dt = current.timestamp_ms.saturating_sub(prev.timestamp_ms);
            if dt > 0 {
                let rx_rate = (current.rx_bytes.saturating_sub(prev.rx_bytes) * 1000) / dt;
                let tx_rate = (current.tx_bytes.saturating_sub(prev.tx_bytes) * 1000) / dt;
                Some(NetInfo { rx_bytes_per_sec: rx_rate, tx_bytes_per_sec: tx_rate })
            } else {
                None
            }
        } else {
            None
        };
        *prev_net = Some(current);
        info
    } else {
        None
    };

    let disks = sections.get("DISK").map(|s| parse_disk(s)).unwrap_or_default();

    let hostname = sections.get("HOST")
        .map(|h| h.trim().to_string())
        .unwrap_or_default();

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    MonitorData {
        monitor_id: monitor_id.to_string(),
        cpu_percent,
        mem_total_mb,
        mem_used_mb,
        mem_percent,
        load_avg,
        processes,
        hostname,
        timestamp,
        error: None,
        net,
        disks,
    }
}

fn split_sections(text: &str) -> HashMap<String, String> {
    let mut sections = HashMap::new();
    let mut current_key = String::new();
    let mut current_val = String::new();

    for line in text.lines() {
        if line.starts_with("===") {
            if !current_key.is_empty() {
                sections.insert(current_key.clone(), current_val.trim().to_string());
            }
            let rest = line.trim_start_matches('=');
            if let Some(idx) = rest.find("===") {
                current_key = rest[..idx].to_string();
                let after = rest[idx..].trim_matches('=');
                current_val = if after.is_empty() { String::new() } else { format!("{after}\n") };
            } else {
                current_key = rest.trim_end_matches('=').to_string();
                current_val.clear();
            }
        } else {
            current_val.push_str(line);
            current_val.push('\n');
        }
    }
    if !current_key.is_empty() {
        sections.insert(current_key, current_val.trim().to_string());
    }
    sections
}

fn parse_cpu(stat: &str, prev: &mut Option<CpuSnapshot>) -> f64 {
    let parts: Vec<&str> = stat.split_whitespace().collect();
    if parts.len() < 9 || parts[0] != "cpu" {
        return 0.0;
    }

    let snap = CpuSnapshot {
        user: parts[1].parse().unwrap_or(0),
        nice: parts[2].parse().unwrap_or(0),
        system: parts[3].parse().unwrap_or(0),
        idle: parts[4].parse().unwrap_or(0),
        iowait: parts[5].parse().unwrap_or(0),
        irq: parts[6].parse().unwrap_or(0),
        softirq: parts[7].parse().unwrap_or(0),
        steal: parts[8].parse().unwrap_or(0),
    };

    let percent = if let Some(ref p) = prev {
        let total_diff = snap.total().saturating_sub(p.total());
        let busy_diff = snap.busy().saturating_sub(p.busy());
        if total_diff > 0 {
            (busy_diff as f64 / total_diff as f64) * 100.0
        } else {
            0.0
        }
    } else {
        let total = snap.total();
        if total > 0 { (snap.busy() as f64 / total as f64) * 100.0 } else { 0.0 }
    };

    *prev = Some(snap);
    (percent * 10.0).round() / 10.0
}

fn parse_meminfo(mem: &str) -> (u64, u64, f64) {
    let mut total_kb: u64 = 0;
    let mut available_kb: u64 = 0;
    let mut free_kb: u64 = 0;
    let mut buffers_kb: u64 = 0;
    let mut cached_kb: u64 = 0;

    for line in mem.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 { continue; }
        let val: u64 = parts[1].parse().unwrap_or(0);
        match parts[0] {
            "MemTotal:" => total_kb = val,
            "MemFree:" => free_kb = val,
            "MemAvailable:" => available_kb = val,
            "Buffers:" => buffers_kb = val,
            "Cached:" => cached_kb = val,
            _ => {}
        }
    }

    let total_mb = total_kb / 1024;
    let used_mb = if available_kb > 0 {
        (total_kb - available_kb) / 1024
    } else {
        (total_kb - free_kb - buffers_kb - cached_kb) / 1024
    };
    let percent = if total_mb > 0 {
        ((used_mb as f64 / total_mb as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };

    (total_mb, used_mb, percent)
}

fn parse_loadavg(load: &str) -> [f64; 3] {
    let parts: Vec<&str> = load.split_whitespace().collect();
    [
        parts.first().and_then(|s| s.parse().ok()).unwrap_or(0.0),
        parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0),
        parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0),
    ]
}

fn parse_ps(ps: &str) -> Vec<ProcessInfo> {
    let mut procs = Vec::new();
    for (i, line) in ps.lines().enumerate() {
        if i == 0 { continue; }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 11 { continue; }

        let pid: u32 = match parts[1].parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let cpu: f64 = parts[2].parse().unwrap_or(0.0);
        let mem: f64 = parts[3].parse().unwrap_or(0.0);
        let command = parts[10..].join(" ");

        procs.push(ProcessInfo {
            pid,
            user: parts[0].to_string(),
            cpu,
            mem,
            command,
        });
    }
    procs
}

fn parse_macos_cpu(text: &str) -> f64 {
    let mut user = 0.0_f64;
    let mut sys = 0.0_f64;
    for part in text.split(',') {
        let part = part.trim();
        if part.contains("user") {
            user = part.split('%').next()
                .and_then(|s| s.split_whitespace().last())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
        } else if part.contains("sys") {
            sys = part.split('%').next()
                .and_then(|s| s.split_whitespace().last())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
        }
    }
    ((user + sys) * 10.0).round() / 10.0
}

fn parse_macos_mem(vm_stat: &str, total_bytes: u64) -> (u64, u64, f64) {
    let total_mb = total_bytes / (1024 * 1024);
    if total_mb == 0 { return (0, 0, 0.0); }

    let page_size: u64 = vm_stat.lines()
        .find(|l| l.contains("page size"))
        .and_then(|l| l.split_whitespace().rev().find(|w| w.ends_with(')')).or_else(|| l.split_whitespace().last()))
        .and_then(|s| s.trim_end_matches(')').parse().ok())
        .unwrap_or(16384);

    let get_pages = |key: &str| -> u64 {
        vm_stat.lines()
            .find(|l| l.contains(key))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|s| s.trim().trim_end_matches('.').parse().ok())
            .unwrap_or(0)
    };

    let active = get_pages("Pages active");
    let wired = get_pages("Pages wired");
    let compressed = get_pages("Pages occupied by compressor");
    let used_bytes = (active + wired + compressed) * page_size;
    let used_mb = used_bytes / (1024 * 1024);
    let pct = ((used_mb as f64 / total_mb as f64) * 1000.0).round() / 10.0;

    (total_mb, used_mb, pct)
}

fn parse_macos_loadavg(text: &str) -> [f64; 3] {
    let cleaned = text.trim().trim_start_matches('{').trim_end_matches('}');
    let parts: Vec<&str> = cleaned.split_whitespace().collect();
    [
        parts.first().and_then(|s| s.parse().ok()).unwrap_or(0.0),
        parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0),
        parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0),
    ]
}

fn parse_linux_net(text: &str) -> (u64, u64) {
    let mut total_rx: u64 = 0;
    let mut total_tx: u64 = 0;
    for line in text.lines() {
        let line = line.trim();
        if !line.contains(':') || line.starts_with("Inter") || line.starts_with("face") {
            continue;
        }
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() < 2 { continue; }
        let iface = parts[0].trim();
        if iface == "lo" { continue; }
        let vals: Vec<&str> = parts[1].split_whitespace().collect();
        if vals.len() < 10 { continue; }
        total_rx += vals[0].parse::<u64>().unwrap_or(0);
        total_tx += vals[8].parse::<u64>().unwrap_or(0);
    }
    (total_rx, total_tx)
}

fn parse_macos_net(text: &str) -> (u64, u64) {
    let mut total_rx: u64 = 0;
    let mut total_tx: u64 = 0;
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() { return (0, 0); }

    let header = lines[0];
    let cols: Vec<&str> = header.split_whitespace().collect();
    let ibytes_idx = cols.iter().position(|&c| c == "Ibytes");
    let obytes_idx = cols.iter().position(|&c| c == "Obytes");

    if let (Some(ri), Some(ti)) = (ibytes_idx, obytes_idx) {
        for line in &lines[1..] {
            let vals: Vec<&str> = line.split_whitespace().collect();
            if vals.is_empty() { continue; }
            if vals[0].starts_with("lo") { continue; }
            if vals.len() > ri.max(ti) {
                total_rx += vals[ri].parse::<u64>().unwrap_or(0);
                total_tx += vals[ti].parse::<u64>().unwrap_or(0);
            }
        }
    }
    (total_rx, total_tx)
}

/// Parse df output: "Filesystem Size Used Avail Use% Mounted"
fn parse_disk(text: &str) -> Vec<DiskInfo> {
    let mut disks = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        // Linux: /dev/sda1 50G 20G 28G 42% /
        // macOS: /dev/disk1s1 466Gi 200Gi 250Gi 45% 10000 1000000 1% /
        if parts.len() < 5 { continue; }
        // Find mount point (last column) and percent (column ending with %)
        let mount = parts.last().unwrap().to_string();
        let pct_str = parts.iter().rev().find(|s| s.ends_with('%'));
        let percent: f64 = pct_str
            .and_then(|s| s.trim_end_matches('%').parse().ok())
            .unwrap_or(0.0);
        let total = parse_size_to_gb(parts[1]);
        let used = parse_size_to_gb(parts[2]);
        if total > 0.0 {
            disks.push(DiskInfo { mount, total_gb: total, used_gb: used, percent });
        }
    }
    disks
}

/// Parse human-readable size (e.g., "50G", "1.2T", "500M", "466Gi") to GB
fn parse_size_to_gb(s: &str) -> f64 {
    let s = s.trim();
    if s.is_empty() { return 0.0; }
    // Strip trailing 'i' for macOS (Gi, Ti, Mi)
    let s = s.trim_end_matches('i');
    let (num, unit) = if s.ends_with('T') {
        (s.trim_end_matches('T'), 1024.0)
    } else if s.ends_with('G') {
        (s.trim_end_matches('G'), 1.0)
    } else if s.ends_with('M') {
        (s.trim_end_matches('M'), 1.0 / 1024.0)
    } else if s.ends_with('K') {
        (s.trim_end_matches('K'), 1.0 / (1024.0 * 1024.0))
    } else {
        return 0.0;
    };
    num.parse::<f64>().unwrap_or(0.0) * unit
}

fn error_data(monitor_id: &str, msg: &str) -> MonitorData {
    MonitorData {
        monitor_id: monitor_id.to_string(),
        cpu_percent: 0.0,
        mem_total_mb: 0,
        mem_used_mb: 0,
        mem_percent: 0.0,
        load_avg: [0.0; 3],
        processes: vec![],
        hostname: String::new(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        error: Some(msg.to_string()),
        net: None,
        disks: vec![],
    }
}
