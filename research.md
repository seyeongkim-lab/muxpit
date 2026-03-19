# Research: Remote Server Monitoring Approaches in Terminal Multiplexers & SSH Tools

## 1. tmux + Monitoring Plugins

### tmux-mem-cpu-load / tmux-cpu / tmux-plugin-sysstat

**Data collection method**: These plugins run **local** system commands and display results in the tmux status bar. They do NOT monitor remote servers -- they monitor the machine where tmux is running.

**CPU collection**:
- Linux: `vmstat -n` (primary), fallback to `top -b`
- macOS: `iostat` (primary), fallback to `top -l`
- FreeBSD: `vmstat -n`
- Calculates CPU usage as `100 - idle_percentage`

**Memory collection**:
- Reads `/proc/meminfo` directly (Linux)
- Uses `MemAvailable` field if present, otherwise calculates from `MemFree + Buffers + Cached`

**Key insight**: tmux plugins are **local-only** -- they monitor the machine running tmux. If tmux is running on a remote server (via SSH), they monitor that server. They are NOT designed for remote monitoring from a local machine.

Sources:
- [tmux-plugins/tmux-cpu](https://github.com/tmux-plugins/tmux-cpu)
- [samoshkin/tmux-plugin-sysstat](https://github.com/samoshkin/tmux-plugin-sysstat)
- [thewtex/tmux-mem-cpu-load](https://github.com/thewtex/tmux-mem-cpu-load)

---

## 2. Termius (SSH Client)

**Monitoring features**: Termius does NOT have built-in remote server monitoring/dashboard for system metrics (CPU, memory, etc.). Its "dashboard" is for business-tier team management (connection reports, activity logs).

**Core features**: Host management, real-time terminal sharing, SFTP, cloud sync of credentials. No system metric collection.

**Conclusion**: Termius is a pure SSH client. You would need to run htop/btop manually within the SSH session.

Sources:
- [Termius](https://termius.com)

---

## 3. MobaXterm

**Monitoring feature**: Has a built-in "Remote Monitoring Bar" displayed below the SSH terminal. Shows CPU, RAM, Network, Disk usage in real-time.

**Data collection method**: Runs SSH commands on the remote server to read from `/proc` filesystem. Specifically mentioned:
- Reads `MemAvailable` from `/proc/meminfo`
- Likely reads `/proc/stat` for CPU, `/proc/net/dev` for network (similar to rtop approach)

**Key details**:
- Enabled by default during SSH sessions
- Labeled as "experimental" -- doesn't work with all Unix systems
- Runs background SSH commands periodically to refresh data
- No agent installation required on remote server

**Conclusion**: MobaXterm is the closest existing example to an SSH client with built-in agentless remote monitoring. It runs standard Linux commands over the SSH connection.

Sources:
- [MobaXterm Features](https://mobaxterm.mobatek.net/features.html)
- [MobaXterm 10.6 Release](https://blog.mobatek.net/post/mobaxterm-new-release-10.6/)

---

## 4. Warp Terminal

**Monitoring features**: None. Warp's "Warpify SSH" feature enables Warp's editor, completions, and history over SSH, but provides NO system monitoring.

**Focus**: AI-powered terminal experience (autocomplete, command search), not server monitoring.

Sources:
- [Warp SSH Docs](https://docs.warp.dev/terminal/warpify/ssh)

---

## 5. Tabby Terminal

**Monitoring features**: None built-in. Tabby focuses on SSH connection management, SFTP, serial console.

**Integration**: Tabby-MCP provides 34 MCP tools for AI agent control of terminal sessions, but no system monitoring.

Sources:
- [Tabby GitHub](https://github.com/Eugeny/tabby)

---

## 6. Grafana/Prometheus Agent Approach (node_exporter / Telegraf)

### Prometheus + node_exporter (Pull-based)
- **Architecture**: Install `node_exporter` agent on each remote server. It exposes metrics on HTTP port (default 9100). Prometheus server scrapes metrics at intervals.
- **Data collection**: node_exporter reads `/proc` and `/sys` filesystem directly (CPU, memory, disk, network, etc.)
- **Pros**: Comprehensive, well-tested, ecosystem of exporters
- **Cons**: Requires agent installation, port exposure, firewall rules

### Telegraf (Push-based)
- **Architecture**: Install Telegraf agent on each remote server. It collects metrics and pushes to InfluxDB/Prometheus.
- **Plugin system**: 200+ input/output/processor plugins
- **Pros**: Flexible, many integrations
- **Cons**: Same as node_exporter -- requires agent installation

**Key insight**: This is the "industry standard" for production monitoring. Heavy setup, full visibility.

Sources:
- [Prometheus node_exporter Guide](https://prometheus.io/docs/guides/node-exporter/)
- [Telegraf vs Prometheus Comparison](https://blog.nashtechglobal.com/telegraf-vs-prometheus-choosing-the-right-metrics-collection-tool/)

---

## 7. Netdata

**Data collection**: Netdata is an **agent-based** monitoring tool. It must be installed on the remote server.

- Runs as a daemon, collects per-second metrics
- Reads `/proc`, `/sys`, and uses OS APIs directly
- Provides a built-in web dashboard (port 19999)
- Can push metrics to Netdata Cloud for centralized view

**SSH integration**: Netdata does NOT work over SSH natively. However:
- It has an SSH Exporter that can monitor SSH server metrics
- Netdata Cloud replaces the need to SSH into servers for diagnostics

**Agentless mode**: Netdata supports SNMP and Prometheus scraping for devices where agents can't be installed, but for full monitoring, the agent is required.

Sources:
- [Netdata](https://www.netdata.cloud/)
- [Netdata Agents](https://www.netdata.cloud/product/netdata-agents/)

---

## 8. htop/btop over SSH

**Approach**: Simply SSH into the remote server and run `htop`, `btop`, `top`, etc.

**How it works**:
- The TUI tool runs entirely on the remote server
- Terminal output is streamed back over the SSH connection
- Reads `/proc/stat`, `/proc/meminfo`, `/proc/[pid]/stat` directly on the server

**Pros**:
- Zero setup if tool is already installed
- Full interactive TUI
- Real-time data with very low overhead
- No custom protocol needed

**Cons**:
- Requires one SSH session per server
- Can't aggregate multiple servers
- Not embeddable in a custom UI
- Needs the tool installed on the server (but htop/top are common)

---

## 9. Glances (Python Monitoring Tool)

**Modes of operation**:

1. **Standalone**: Run locally or via SSH (`ssh user@server glances`)
2. **Client-Server mode**: Run `glances -s` on server (listens on port), `glances -c server_ip` on client
3. **Web mode**: `glances -w` serves a web UI on port 61208
4. **API mode**: XMLRPC and RESTful API for programmatic access
5. **Browser mode**: `glances --browser` discovers and lists all Glances servers

**Data collection**: Uses the `psutil` Python library, which reads from `/proc` on Linux.

**Pros**: Multiple deployment modes, REST API, web UI
**Cons**: Requires Python + glances installed on remote server for all modes except plain SSH

Sources:
- [Glances Documentation](https://glances.readthedocs.io/en/latest/quickstart.html)
- [Glances GitHub](https://github.com/nicolargo/glances)

---

## 10. Agentless SSH-Based Monitoring Tools

### rtop (Go, MIT License) -- KEY REFERENCE IMPLEMENTATION

**Architecture**: Runs on local machine, connects to remote servers via SSH, executes commands to collect metrics.

**Exact commands executed over SSH**:
```
/bin/cat /proc/uptime         -> system uptime
/bin/hostname -f              -> hostname
/bin/cat /proc/loadavg        -> load averages (1, 5, 15 min)
/bin/cat /proc/meminfo        -> memory stats (total, free, buffers, cached, swap)
/bin/df -B1                   -> disk usage in bytes
/bin/ip -o addr               -> network interface addresses (fallback: /sbin/ip -o addr)
/bin/cat /proc/net/dev        -> network RX/TX bytes
/bin/cat /proc/stat           -> CPU times (user, nice, system, idle, iowait, irq, softirq, steal)
```

**Refresh**: Every 5 seconds by default.

**Key insight**: This is the simplest and most relevant reference for wmux. Pure SSH, no agent, reads `/proc` files directly.

Sources:
- [rtop](http://www.rtop-monitor.org/)
- [rtop GitHub](https://github.com/rapidloop/rtop)

### SshSysMon (Python)

**Architecture**: YAML-configured, connects to servers via SSH, runs commands, provides summary/alerting.

**Data collection**: Reads `/proc` files and runs simple commands (`df`, etc.) over SSH.

**Features**: Alerting, configurable thresholds, Docker support.

Sources:
- [SshSysMon GitHub](https://github.com/zix99/sshsysmon)

### checkah (Shell-based)

**Architecture**: Agentless SSH-based monitoring and alerting tool.

Sources:
- [checkah GitHub](https://github.com/deadc0de6/checkah)

### Enterprise Tools with SSH Monitoring
- **PRTG**: SSH sensors for Linux monitoring
- **Zabbix**: SSH-based checks (agentless mode)
- **LogicMonitor**: Linux monitoring via SSH
- **Icinga**: `check_by_ssh` for agentless monitoring

---

## Comparison Table

| Approach | Agent Required | Setup Complexity | Data Freshness | Multi-Server | Embeddable in Custom UI | Best For |
|---|---|---|---|---|---|---|
| **SSH + /proc reading** (rtop approach) | No | Very Low | 1-5 sec refresh | Yes (parallel SSH) | Yes | Lightweight monitoring in terminal apps |
| **htop/btop over SSH** | Tool on server | Very Low | Real-time | No (1 session each) | No (full TUI) | Ad-hoc debugging |
| **MobaXterm-style bar** | No | None (built-in) | ~5 sec refresh | Per-session only | N/A (proprietary) | SSH client users |
| **Glances client-server** | Glances on server | Medium | Real-time | Yes (browser mode) | Yes (REST API) | Teams with Python infra |
| **Prometheus + node_exporter** | Yes (agent) | High | 15-60 sec scrape | Yes (centralized) | Yes (PromQL API) | Production infrastructure |
| **Telegraf + InfluxDB** | Yes (agent) | High | Configurable | Yes (centralized) | Yes (InfluxQL API) | Production infrastructure |
| **Netdata** | Yes (agent) | Medium | Per-second | Yes (Cloud) | Yes (API) | Real-time dashboards |
| **tmux plugins** | No (local only) | Low | 5 sec refresh | No | No | Status bar display |
| **SshSysMon** | No | Low | Scheduled | Yes | No (CLI output) | Alerting/scheduled checks |

---

## Industry Standard Assessment

### For Production Infrastructure Monitoring:
**Agent-based** (Prometheus/Grafana, Telegraf/InfluxDB, Netdata) is the industry standard. Reasons:
- More reliable data collection
- Historical data storage
- Alerting capabilities
- Ecosystem of dashboards and integrations

### For Terminal Multiplexer / SSH Client Built-in Monitoring:
**Agentless SSH command execution** (rtop approach) is the standard. Reasons:
- Zero setup on remote servers
- Uses existing SSH credentials
- Reads standard Linux `/proc` files
- Lightweight and predictable

### Recommended Approach for wmux:

The **rtop model** (SSH + `/proc` reading) is the most appropriate for a terminal multiplexer:

1. **Execute a small set of commands over the existing SSH connection**:
   - `cat /proc/stat` (CPU)
   - `cat /proc/meminfo` (Memory)
   - `cat /proc/loadavg` (Load)
   - `df -B1` (Disk)
   - `cat /proc/net/dev` (Network)
   - `cat /proc/uptime` (Uptime)
   - `hostname -f` (Hostname)

2. **Parse the output** on the local side (in Rust for wmux)

3. **Refresh every 3-5 seconds** via the same SSH session

4. **Display as a status bar or panel** (like MobaXterm's approach)

**Advantages over alternatives**:
- No agent installation required
- Reuses existing SSH connection (no extra ports)
- Works on virtually any Linux server
- Minimal bandwidth (~2-5 KB per collection cycle)
- All commands are read-only and non-invasive
- Can be implemented in a single SSH session using command chaining:
  ```bash
  cat /proc/stat && cat /proc/meminfo && cat /proc/loadavg && df -B1 && cat /proc/net/dev && cat /proc/uptime && hostname -f
  ```
  Or even more efficiently as a single command to minimize round trips:
  ```bash
  echo "===STAT===" && cat /proc/stat && echo "===MEM===" && cat /proc/meminfo && echo "===LOAD===" && cat /proc/loadavg && echo "===DISK===" && df -B1 && echo "===NET===" && cat /proc/net/dev && echo "===UPTIME===" && cat /proc/uptime && echo "===HOST===" && hostname -f
  ```

**Limitations**:
- Linux-only (`/proc` filesystem is Linux-specific)
- macOS remotes need different commands (`sysctl`, `vm_stat`, `iostat`)
- FreeBSD remotes also differ (`sysctl`, `vmstat`)
- Some hardened servers may restrict SSH command execution
