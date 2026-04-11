# Plan: Linux Porting

## 요약

wmux를 Windows 전용에서 Windows + Linux 크로스플랫폼으로 포팅한다.
기존 Windows 코드는 `#[cfg(windows)]`로 유지하고, `#[cfg(unix)]` 블록으로 Linux 구현을 추가한다.

## 변경 범위

### 1. ipc.rs - Named Pipes → Unix Domain Socket (CRITICAL)

- Windows: `\\.\pipe\wmux` (기존 유지)
- Linux: `/tmp/wmux.sock` (Unix Domain Socket)
- `accept_client()` 의 `#[cfg(not(windows))]` 블록을 실제 UDS 구현으로 교체

### 2. sysinfo.rs - PowerShell/netstat → /proc 기반 (CRITICAL)

| 함수 | Windows (유지) | Linux (신규) |
|------|---------------|-------------|
| `get_process_cwd(pid)` | PowerShell Get-Process | `readlink /proc/{pid}/cwd` |
| `get_listening_ports(pid)` | `netstat -ano -p TCP` | `ss -tlnp` 파싱 |
| `get_shell_context(pid)` | PowerShell WMI | `/proc/{pid}/task/*/children` + `/proc/{child}/cmdline` |
| `gather_workspace_info` | `C:\` fallback | `/` fallback |
| `silent_command` | CREATE_NO_WINDOW | 그냥 Command::new |

### 3. lib.rs - 폰트 목록 (HIGH)

- Windows: PowerShell System.Drawing (유지)
- Linux: `fc-list :family` → 파싱

### 4. monitor.rs - CREATE_NO_WINDOW (MINOR)

- `#[cfg(windows)]` 블록들은 이미 조건부 → Linux에서 자동 무시
- 변경 불필요

### 5. Cargo.toml (MINOR)

- `windows-sys`는 이미 `[target.'cfg(windows)'.dependencies]` → 변경 불필요
- description만 "terminal for AI agents"로 변경

### 6. 프론트엔드 (COSMETIC)

- `App.tsx:423` → "Terminal Multiplexer for Windows" → "Terminal Multiplexer"
- `useWorkspaceInfo.ts:69` → `C:\Users\one` → 플랫폼 무관 fallback

## 빌드/테스트 환경

- 리눅스 빌드: `seyeongkim@192.168.0.7`
- SSH로 소스 전송 후 `cargo build` + `pnpm build`

## 리스크

- `portable-pty` 크레이트가 Linux에서 정상 동작하는지 확인 필요 (공식 지원됨)
- Tauri v2 Linux 의존성 설치 필요 (webkit2gtk, libappindicator 등)
