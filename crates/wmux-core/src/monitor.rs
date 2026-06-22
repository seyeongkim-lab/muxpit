use serde::{Deserialize, Serialize};

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
    pub link_speed_mbps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSession {
    pub project: String,
    pub project_path: String,
    pub session_id: String,
    pub started_at: Option<String>,
    pub last_activity: Option<String>,
    pub message_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub mount: String,
    pub total_gb: f64,
    pub used_gb: f64,
    pub percent: f64,
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
    pub claude_sessions: Vec<ClaudeSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionContentEvent {
    pub request_id: String,
    pub lines: Vec<String>,
    pub error: Option<String>,
}
