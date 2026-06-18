# Plan: OS Abstraction Review

## 요약

2026-06-18에 `$parallel-code-review`를 15개 reviewer로 실행해 전체 저장소를
검토했다. 관점은 "OS별 추상화를 확실히 나누기"였지만, 실제 결과는 순수
크로스플랫폼 설계 문제보다 이미 드러난 버그가 더 많았다.

핵심 결론:

- 대부분의 발견은 일반 버그다.
- 다만 반복되는 원인은 공통적이다: SSH/remote command를 문자열로 다루고,
  OS별 capability를 typed boundary 없이 곳곳에서 직접 판단한다.
- 따라서 대규모 리라이트보다, bug fix를 하면서 경계를 세우는 접근이 맞다.

## 분류

### 진짜 OS 추상화 문제

| 영역 | 현재 문제 | 원하는 경계 |
|------|-----------|-------------|
| SSH 연결 | `ssh ...` 문자열을 만들고 여러 곳에서 다시 파싱 | `SshConnection` 또는 argv 기반 typed model |
| IPC | Windows pipe와 Unix socket 상수가 app/CLI에 중복 | shared IPC endpoint resolver + request/response schema |
| cwd/process tree | Windows, Linux, Unix 동작이 함수 내부에 섞임 | `PlatformProcess` adapter |
| hooks | `HOME`, POSIX shell, `PATHEXT`, rename semantics가 섞임 | `HookPlatform` adapter |
| local sysinfo | `cfg(unix)`가 사실상 Linux `/proc`, `ss`, `fc-list` | `target_os = "linux"`와 명시적 unsupported/macOS path |
| persisted state | OS 의존 command/path/settings가 marker 없이 restore됨 | store schema version + source platform marker |

### 일반 버그에 가까운 문제

- tmux persist reconnect가 전역 `pty-exit` auto-close에 막힘
- Claude session fetch 요청이 하나만 저장되어 덮어쓰기 발생
- terminal startup 중 pane close 시 hidden PTY leak 가능
- Windows named pipe accept 실패 경로에서 handle leak 가능
- workspace port detection이 PTY root PID만 확인

### 보안/quoting 버그

- Claude session path/session id가 remote shell command에 그대로 삽입된다.
- 이 문제는 크로스플랫폼 자체는 아니지만, SSH/remote command boundary 부재와
  같은 뿌리라서 우선순위가 높다.

## 검증된 리뷰 포인트

| 우선 | 이슈 | 긴급도 | 근거 | 권장 수정 |
|---:|------|--------|------|-----------|
| 1 | Claude 세션 경로/파일명이 remote shell 명령에 그대로 삽입됨 | High | `src-tauri/src/monitor.rs:310`, `src/App.tsx:687` | remote path/session id를 validate하고 POSIX quoting helper 또는 backend command builder 사용 |
| 2 | tmux persist reconnect가 전역 `pty-exit` auto-close에 막힘 | High | `src/components/Terminal.tsx:362`, `src/App.tsx:302` | `tmuxSession` leaf는 app auto-close에서 제외하거나 exit policy를 한 곳으로 통합 |
| 3 | SSH 연결 정보를 flat string으로 저장하고 여러 방식으로 파싱함 | Medium | `src/stores/sshHosts.ts:131`, `src-tauri/src/pty.rs:173`, `src-tauri/src/tmux_remote.rs:24` | structured argv/config로 전환. 문자열 파싱은 legacy migration으로 제한 |
| 4 | Monitor/Claude 흐름이 저장된 SSH port/key/options를 버림 | Medium | `src/App.tsx:650`, `src-tauri/src/monitor.rs:184` | display target과 connection state를 분리하고 full argv/config 전달 |
| 5 | Unix IPC가 전역 `/tmp/wmux.sock`을 사용하고 시작 시 무조건 삭제함 | Medium | `src-tauri/src/ipc.rs:9`, `wmux-cli/src/main.rs:249` | `$XDG_RUNTIME_DIR`/`/run/user/$UID` 하위 private socket 또는 singleton 정책 |
| 6 | Windows cwd 추상화가 실제 cwd가 아니라 실행 파일 위치를 반환함 | Medium | `src-tauri/src/sysinfo.rs:31`, `src/components/Terminal.tsx:57` | OSC 7/file URL을 platform-aware parsing하고 Windows cwd를 fake 값으로 반환하지 않음 |
| 7 | Windows `wmux-cli hooks`가 Unix 전제를 가짐 | Medium | `wmux-cli/src/hooks.rs:47`, `wmux-cli/src/hooks.rs:499` | config dir, PATH/PATHEXT, shell snippet, replace semantics를 Windows adapter로 분리 |
| 8 | port detection이 PTY root PID만 봄 | Medium | `src/hooks/useWorkspaceInfo.ts:84`, `src-tauri/src/sysinfo.rs:125` | process tree를 OS별로 resolve한 뒤 descendant PID 전체로 port match |
| 9 | Claude session fetch 요청이 하나만 저장됨 | Medium | `src-tauri/src/monitor.rs:89`, `src-tauri/src/monitor.rs:307` | `Option<FetchRequest>` 대신 queue/request-id map 사용 |
| 10 | terminal startup 중 pane close 시 hidden PTY가 남을 수 있음 | Medium | `src/components/Terminal.tsx:205`, `src/components/Terminal.tsx:519` | startup cancellation 추가, spawn 후 leaf가 없어졌으면 `kill_pty` |
| 11 | Windows named pipe accept 실패 경로에서 handle leak 가능 | Low | `src-tauri/src/ipc.rs:67`, `src-tauri/src/ipc.rs:82` | raw handle을 RAII로 감싸거나 실패 반환 전 `CloseHandle` 호출 |

## 권장 작업 순서

### Phase 1. 즉시 버그 수정

범위가 작고 추상화 작업을 기다릴 필요가 없는 항목부터 처리한다.

1. tmux persist reconnect와 app auto-close 충돌 수정
2. Claude session fetch queue 처리
3. Windows named pipe handle leak 수정
4. terminal startup cancellation 추가
5. port detection을 process tree 기반으로 확장

### Phase 2. SSH/remote command boundary 정리

가장 많은 버그의 공통 원인이다.

1. `SshConnection` 타입 또는 argv array를 정의한다.
2. saved host, restored session, monitor, tmux side-channel, AI probe가 같은
   connection contract를 쓰게 한다.
3. remote shell command는 별도 helper에서 POSIX quoting을 강제한다.
4. 기존 flat string command는 migration/legacy path로만 남긴다.

### Phase 3. OS platform adapter 분리

파일 기준으로 분리하기보다 capability 기준으로 분리한다.

- `ipc`: endpoint resolve, permission, singleton/multi-instance policy
- `process`: cwd, descendants, listening ports, shell context
- `hooks`: config dir, binary lookup, hook command, atomic replace
- `fonts/sysinfo`: Windows, Linux, unsupported Unix를 명시적으로 분리

### Phase 4. 검증 게이트 추가

최소 게이트:

- `pnpm exec tsc --noEmit`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path wmux-cli/Cargo.toml`
- SSH argv parser/quoting unit tests
- Windows hook path/PATHEXT/replace unit tests
- Linux IPC socket path/permission test 가능 범위 검토

## 설계 질문

1. macOS는 unsupported인가, 아니면 `unix` abstraction 대상인가?
2. wmux GUI는 singleton이어야 하는가, multi-instance를 지원해야 하는가?
3. `wmux-session` localStorage state는 Windows/Linux 간 portable이어야 하는가,
   아니면 platform-local state로 봐야 하는가?

## 검증 메모

- `pnpm exec tsc --noEmit --pretty false`는 성공했다.
- 한 reviewer가 `Terminal.tsx`의 `idAssigned const 재할당` 빌드 오류를 보고했지만,
  현재 코드는 `let idAssigned = false`라서 최종 finding에서 제외했다.
