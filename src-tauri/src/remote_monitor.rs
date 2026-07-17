use crate::monitor::{ClaudeSession, DiskInfo, MonitorData, NetInfo, ProcessInfo};
use crate::ssh_command::quote_posix_shell_arg;
use std::collections::HashMap;

pub const END_MARKER: &str = "===MUXPIT_END===";
pub const CLAUDE_END_MARKER: &str = "===MUXPIT_CLAUDE_END===";

#[derive(Default)]
pub struct MonitorSnapshots {
    prev_cpu: Option<CpuSnapshot>,
    prev_net: Option<NetSnapshot>,
}

#[derive(Clone, Default)]
struct NetSnapshot {
    rx_bytes: u64,
    tx_bytes: u64,
    timestamp_ms: u64,
}

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
        self.user
            + self.nice
            + self.system
            + self.idle
            + self.iowait
            + self.irq
            + self.softirq
            + self.steal
    }

    fn busy(&self) -> u64 {
        self.total() - self.idle - self.iowait
    }
}

pub fn build_claude_script() -> String {
    format!(
        r#"if [ -d "$HOME/.claude/projects" ]; then for dir in "$HOME/.claude/projects"/*/; do pdir=$(basename "$dir"); echo "===CPROJ===$pdir"; ls -t "$dir"*.jsonl 2>/dev/null | head -3 | while read f; do sid=$(basename "$f" .jsonl); lines=$(wc -l < "$f" 2>/dev/null | tr -d ' '); first=$(head -1 "$f" 2>/dev/null); last=$(tail -1 "$f" 2>/dev/null); cwd=$(printf '%s\n%s\n' "$last" "$first" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1); printf 'CSESS\t%s\t%s\t%s\t%s\t%s\n' "$sid" "$lines" "$cwd" "$first" "$last"; done; done; fi; echo '{END}'"#,
        END = CLAUDE_END_MARKER,
    )
}

pub fn build_collect_script() -> String {
    format!(
        r#"OS=$(uname -s); echo "===OS===$OS"; if [ "$OS" = "Darwin" ]; then echo '===CPU===' && top -l 1 -n 0 -s 0 2>/dev/null | grep 'CPU usage' && echo '===MEM===' && vm_stat 2>/dev/null && echo "===MEMTOTAL===$(sysctl -n hw.memsize 2>/dev/null)" && echo '===LOAD===' && sysctl -n vm.loadavg 2>/dev/null && echo '===NET===' && netstat -ib 2>/dev/null | head -20 && echo '===NETSPEED===' && {{ for svc in $(networksetup -listallnetworkservices 2>/dev/null | tail -n +2); do info=$(networksetup -getinfo "$svc" 2>/dev/null); ip=$(echo "$info" | grep '^IP address:' | head -1 | awk -F': ' '{{print $2}}'); if [ -n "$ip" ] && [ "$ip" != "none" ]; then media=$(networksetup -getMedia "$svc" 2>/dev/null | head -1); echo "$svc:$media"; fi; done; true; }} && echo '===DISK===' && df -h 2>/dev/null | grep '^/dev/' && echo '===PS===' && ps aux -r 2>/dev/null | head -11 && echo '===HOST===' && hostname; else echo '===STAT===' && head -1 /proc/stat && echo '===MEM===' && head -5 /proc/meminfo && echo '===LOAD===' && cat /proc/loadavg && echo '===NET===' && cat /proc/net/dev && echo '===NETSPEED===' && {{ for iface in /sys/class/net/*/; do n=$(basename "$iface"); [ "$n" != "lo" ] && s=$(cat "$iface/speed" 2>/dev/null) && [ -n "$s" ] && [ "$s" -gt 0 ] 2>/dev/null && echo "$n:$s"; done; true; }} && echo '===DISK===' && df -h -x tmpfs -x squashfs -x devtmpfs -x overlay -x efivarfs 2>/dev/null | tail -n +2 && echo '===PS===' && ps aux --sort=-%cpu 2>/dev/null | head -11 && echo '===HOST===' && hostname -f 2>/dev/null || hostname; fi; echo '{END_MARKER}'"#,
        END_MARKER = END_MARKER,
    )
}

pub fn build_claude_fetch_command(
    project: &str,
    session_id: &str,
    marker: &str,
) -> Result<String, String> {
    let project = safe_remote_path_component(project)
        .ok_or_else(|| "Invalid Claude project name".to_string())?;
    let session_id = safe_remote_path_component(session_id)
        .ok_or_else(|| "Invalid Claude session id".to_string())?;
    Ok(format!(
        "cat \"$HOME/.claude/projects/{project}/{session_id}.jsonl\" 2>/dev/null; echo {}",
        quote_posix_shell_arg(marker),
    ))
}

fn safe_remote_path_component(value: &str) -> Option<&str> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        None
    } else {
        Some(value)
    }
}

pub fn parse_remote_output(
    text: &str,
    monitor_id: &str,
    snapshots: &mut MonitorSnapshots,
) -> MonitorData {
    let sections = split_sections(text);
    let is_macos = sections
        .get("OS")
        .map(|s| s.trim() == "Darwin")
        .unwrap_or(false);

    let (cpu_percent, mem_total_mb, mem_used_mb, mem_percent, load_avg, processes) = if is_macos {
        let cpu = sections
            .get("CPU")
            .map(|s| parse_macos_cpu(s))
            .unwrap_or(0.0);
        let (total, used, pct) = if let Some(mem) = sections.get("MEM") {
            let total_bytes: u64 = sections
                .get("MEMTOTAL")
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            parse_macos_mem(mem, total_bytes)
        } else {
            (0, 0, 0.0)
        };
        let load = sections
            .get("LOAD")
            .map(|s| parse_macos_loadavg(s))
            .unwrap_or([0.0; 3]);
        let procs = sections.get("PS").map(|s| parse_ps(s)).unwrap_or_default();
        (cpu, total, used, pct, load, procs)
    } else {
        let cpu = sections
            .get("STAT")
            .map(|s| parse_cpu(s, &mut snapshots.prev_cpu))
            .unwrap_or(0.0);
        let (total, used, pct) = sections
            .get("MEM")
            .map(|s| parse_meminfo(s))
            .unwrap_or((0, 0, 0.0));
        let load = sections
            .get("LOAD")
            .map(|s| parse_loadavg(s))
            .unwrap_or([0.0; 3]);
        let procs = sections.get("PS").map(|s| parse_ps(s)).unwrap_or_default();
        (cpu, total, used, pct, load, procs)
    };

    let link_speed_mbps = sections
        .get("NETSPEED")
        .and_then(|s| parse_net_speed(s, is_macos));

    let net = if let Some(net_text) = sections.get("NET") {
        let (rx, tx) = if is_macos {
            parse_macos_net(net_text)
        } else {
            parse_linux_net(net_text)
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let current = NetSnapshot {
            rx_bytes: rx,
            tx_bytes: tx,
            timestamp_ms: now_ms,
        };
        let info = if let Some(ref prev) = snapshots.prev_net {
            let dt = current.timestamp_ms.saturating_sub(prev.timestamp_ms);
            if dt > 0 {
                let rx_rate = (current.rx_bytes.saturating_sub(prev.rx_bytes) * 1000) / dt;
                let tx_rate = (current.tx_bytes.saturating_sub(prev.tx_bytes) * 1000) / dt;
                Some(NetInfo {
                    rx_bytes_per_sec: rx_rate,
                    tx_bytes_per_sec: tx_rate,
                    link_speed_mbps,
                })
            } else {
                None
            }
        } else {
            None
        };
        snapshots.prev_net = Some(current);
        info
    } else {
        None
    };

    let disks = sections
        .get("DISK")
        .map(|s| parse_disk(s))
        .unwrap_or_default();

    let hostname = sections
        .get("HOST")
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
        claude_sessions: vec![],
    }
}

fn split_sections(text: &str) -> HashMap<String, String> {
    let mut sections = HashMap::new();
    let mut current_key = String::new();
    let mut current_val = String::new();

    for line in text.lines() {
        let marker = line.trim_start();
        if marker.starts_with("===") {
            if !current_key.is_empty() {
                sections.insert(current_key.clone(), current_val.trim().to_string());
            }
            let rest = marker.trim_start_matches('=');
            if let Some(idx) = rest.find("===") {
                current_key = rest[..idx].to_string();
                let after = rest[idx..].trim_matches('=');
                current_val = if after.is_empty() {
                    String::new()
                } else {
                    format!("{after}\n")
                };
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
        if total > 0 {
            (snap.busy() as f64 / total as f64) * 100.0
        } else {
            0.0
        }
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
        if parts.len() < 2 {
            continue;
        }
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
        if i == 0 {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 11 {
            continue;
        }

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
            user = part
                .split('%')
                .next()
                .and_then(|s| s.split_whitespace().last())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
        } else if part.contains("sys") {
            sys = part
                .split('%')
                .next()
                .and_then(|s| s.split_whitespace().last())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
        }
    }
    ((user + sys) * 10.0).round() / 10.0
}

fn parse_macos_mem(vm_stat: &str, total_bytes: u64) -> (u64, u64, f64) {
    let total_mb = total_bytes / (1024 * 1024);
    if total_mb == 0 {
        return (0, 0, 0.0);
    }

    let page_size: u64 = vm_stat
        .lines()
        .find(|l| l.contains("page size"))
        .and_then(|l| {
            l.split_whitespace()
                .rev()
                .find(|w| w.ends_with(')'))
                .or_else(|| l.split_whitespace().last())
        })
        .and_then(|s| s.trim_end_matches(')').parse().ok())
        .unwrap_or(16384);

    let get_pages = |key: &str| -> u64 {
        vm_stat
            .lines()
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
        if parts.len() < 2 {
            continue;
        }
        let iface = parts[0].trim();
        if iface == "lo" {
            continue;
        }
        let vals: Vec<&str> = parts[1].split_whitespace().collect();
        if vals.len() < 10 {
            continue;
        }
        total_rx += vals[0].parse::<u64>().unwrap_or(0);
        total_tx += vals[8].parse::<u64>().unwrap_or(0);
    }
    (total_rx, total_tx)
}

fn parse_macos_net(text: &str) -> (u64, u64) {
    let mut total_rx: u64 = 0;
    let mut total_tx: u64 = 0;
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return (0, 0);
    }

    let header = lines[0];
    let cols: Vec<&str> = header.split_whitespace().collect();
    let ibytes_idx = cols.iter().position(|&c| c == "Ibytes");
    let obytes_idx = cols.iter().position(|&c| c == "Obytes");

    if let (Some(ri), Some(ti)) = (ibytes_idx, obytes_idx) {
        for line in &lines[1..] {
            let vals: Vec<&str> = line.split_whitespace().collect();
            if vals.is_empty() {
                continue;
            }
            if vals[0].starts_with("lo") {
                continue;
            }
            if vals.len() > ri.max(ti) {
                total_rx += vals[ri].parse::<u64>().unwrap_or(0);
                total_tx += vals[ti].parse::<u64>().unwrap_or(0);
            }
        }
    }
    (total_rx, total_tx)
}

fn parse_net_speed(text: &str, is_macos: bool) -> Option<u32> {
    let mut max_speed: u32 = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if is_macos {
            if let Some(media) = line.split(':').nth(1) {
                let media = media.trim();
                if let Some(speed) = extract_speed_from_media(media) {
                    max_speed = max_speed.max(speed);
                }
            }
        } else if let Some(speed_str) = line.split(':').nth(1) {
            if let Ok(speed) = speed_str.trim().parse::<u32>() {
                max_speed = max_speed.max(speed);
            }
        }
    }
    if max_speed > 0 {
        Some(max_speed)
    } else {
        None
    }
}

fn extract_speed_from_media(media: &str) -> Option<u32> {
    let media = media.to_lowercase();
    if media.contains("10gbase") || media.contains("10gigabit") {
        return Some(10000);
    }
    if media.contains("5gbase") {
        return Some(5000);
    }
    if media.contains("2.5gbase") {
        return Some(2500);
    }
    if media.contains("1000base") || media.contains("gigabit") {
        return Some(1000);
    }
    if media.contains("100base") {
        return Some(100);
    }
    if media.contains("10base") {
        return Some(10);
    }
    None
}

fn parse_disk(text: &str) -> Vec<DiskInfo> {
    let mut disks = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let mount = parts.last().unwrap().to_string();
        let pct_str = parts.iter().rev().find(|s| s.ends_with('%'));
        let percent: f64 = pct_str
            .and_then(|s| s.trim_end_matches('%').parse().ok())
            .unwrap_or(0.0);
        let total = parse_size_to_gb(parts[1]);
        let used = parse_size_to_gb(parts[2]);
        if total > 0.0 {
            disks.push(DiskInfo {
                mount,
                total_gb: total,
                used_gb: used,
                percent,
            });
        }
    }
    disks
}

fn parse_size_to_gb(s: &str) -> f64 {
    let s = s.trim();
    if s.is_empty() {
        return 0.0;
    }
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

pub fn parse_claude_sessions(text: &str) -> Vec<ClaudeSession> {
    let mut sessions = Vec::new();
    let mut current_project = String::new();

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("===CPROJ===") {
            current_project = line.trim_start_matches("===CPROJ===").to_string();
        } else if line.starts_with("CSESS\t") {
            if let Some(session) = parse_claude_tab_session(line, &current_project) {
                sessions.push(session);
            }
        } else if line.starts_with("CSESS:") {
            let parts: Vec<&str> = line.splitn(5, ':').collect();
            if parts.len() >= 3 {
                let session_id = parts[1].to_string();
                let message_count: u32 = parts[2].parse().unwrap_or(0);

                let started_at = if parts.len() > 3 {
                    extract_timestamp(parts[3])
                } else {
                    None
                };
                let last_activity = if parts.len() > 4 {
                    extract_timestamp(parts[4])
                } else {
                    None
                };

                let project_path = decode_project_path(&current_project);

                sessions.push(ClaudeSession {
                    project: current_project.clone(),
                    project_path,
                    session_id,
                    started_at,
                    last_activity,
                    message_count,
                });
            }
        }
    }
    sessions
}

fn parse_claude_tab_session(line: &str, current_project: &str) -> Option<ClaudeSession> {
    let row = line.strip_prefix("CSESS\t")?;
    let parts: Vec<&str> = row.splitn(5, '\t').collect();
    if parts.len() < 2 {
        return None;
    }

    let session_id = parts[0].to_string();
    let message_count: u32 = parts[1].parse().unwrap_or(0);
    let cwd = parts
        .get(2)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| {
            parts
                .get(3)
                .and_then(|json| extract_json_string_field(json, "cwd"))
        })
        .or_else(|| {
            parts
                .get(4)
                .and_then(|json| extract_json_string_field(json, "cwd"))
        });
    let first_json = parts.get(3).copied().unwrap_or("");
    let last_json = parts.get(4).copied().unwrap_or("");

    Some(ClaudeSession {
        project: current_project.to_string(),
        project_path: cwd.unwrap_or_else(|| decode_project_path(current_project)),
        session_id,
        started_at: extract_json_string_field(first_json, "timestamp")
            .or_else(|| extract_timestamp(first_json)),
        last_activity: extract_json_string_field(last_json, "timestamp")
            .or_else(|| extract_timestamp(last_json)),
        message_count,
    })
}

fn extract_json_string_field(json_str: &str, field: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json_str).ok()?;
    value.get(field)?.as_str().map(|value| value.to_string())
}

fn extract_timestamp(json_str: &str) -> Option<String> {
    if let Some(idx) = json_str.find("\"timestamp\":\"") {
        let start = idx + "\"timestamp\":\"".len();
        if let Some(end) = json_str[start..].find('"') {
            return Some(json_str[start..start + end].to_string());
        }
    }
    None
}

fn decode_project_path(encoded: &str) -> String {
    let result: String = encoded
        .chars()
        .map(|c| if c == '-' { '/' } else { c })
        .collect();
    if result.is_empty() {
        encoded.to_string()
    } else {
        format!("/{}", result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_script_contains_both_remote_os_branches() {
        let script = build_collect_script();
        assert!(script.contains("Darwin"));
        assert!(script.contains("/proc/stat"));
        assert!(script.contains("done; true; } && echo '===DISK==='"));
        assert!(script.contains(END_MARKER));
    }

    #[test]
    fn claude_fetch_rejects_path_components() {
        assert!(build_claude_fetch_command("good.project", "session-1", "MARK").is_ok());
        assert!(build_claude_fetch_command("../bad", "session-1", "MARK").is_err());
        assert!(build_claude_fetch_command("..", "session-1", "MARK").is_err());
        assert!(build_claude_fetch_command("project", ".", "MARK").is_err());
        assert!(build_claude_fetch_command("project", "bad/session", "MARK").is_err());
    }

    #[test]
    fn parse_linux_monitor_output() {
        let mut snapshots = MonitorSnapshots::default();
        let data = parse_remote_output(
            "===OS===Linux\n\
             ===STAT===cpu  10 0 10 80 0 0 0 0\n\
             ===MEM===MemTotal: 2048000 kB\nMemAvailable: 1024000 kB\n\
             ===LOAD===0.1 0.2 0.3 1/2 3\n\
             ===NET===eth0: 100 0 0 0 0 0 0 0 50 0 0 0 0 0 0 0\n\
             ===NETSPEED===eth0:1000\n\
             ===DISK===/dev/sda1 10G 5G 5G 50% /\n\
             ===PS===USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nme 12 1.5 2.5 0 0 ? S 00:00 0:00 node app.js\n\
             ===HOST===host.example",
            "m1",
            &mut snapshots,
        );
        assert_eq!(data.monitor_id, "m1");
        assert_eq!(data.mem_total_mb, 2000);
        assert_eq!(data.load_avg, [0.1, 0.2, 0.3]);
        assert_eq!(data.disks.len(), 1);
        assert_eq!(data.processes.len(), 1);
    }

    #[test]
    fn parse_link_speed_by_remote_os() {
        assert_eq!(parse_net_speed("eth0:1000", false), Some(1000));
        assert_eq!(
            parse_net_speed("Ethernet:1000baseT <full-duplex>", true),
            Some(1000)
        );
    }

    #[test]
    fn parse_claude_session_rows() {
        let rows = "===CPROJ===home-me-app\nCSESS:s1:7:{\"timestamp\":\"2026-01-01T00:00:00Z\"}:{\"timestamp\":\"2026-01-01T00:01:00Z\"}\n";
        let sessions = parse_claude_sessions(rows);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].project_path, "/home/me/app");
        assert_eq!(sessions[0].message_count, 7);
    }

    #[test]
    fn parse_tab_claude_session_rows_prefers_reported_cwd() {
        let rows = "===CPROJ===home-me-my-app\nCSESS\ts1\t7\t/home/me/my-app\t{\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/ignored\"}\t{\"timestamp\":\"2026-01-01T00:01:00Z\"}\n";
        let sessions = parse_claude_sessions(rows);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].project_path, "/home/me/my-app");
        assert_eq!(
            sessions[0].started_at.as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(
            sessions[0].last_activity.as_deref(),
            Some("2026-01-01T00:01:00Z")
        );
    }
}
