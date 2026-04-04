# Plan: Auto Claude Split on SSH Connection

## 요구사항 요약

SSH 호스트에 연결할 때, 원격 서버에 `claude` CLI가 설치되어 있으면 자동으로 터미널을 수평 분할하여 `claude --dangerously-skip-permissions`를 실행한다.

- **FR-1**: SSH 연결 확립 후, 원격에 `claude` CLI 존재 여부 확인
- **FR-2**: `claude`가 있으면 수평 분할 + 새 pane에서 `ssh -t user@host "claude --dangerously-skip-permissions"` 실행
- **FR-3**: `claude`가 없으면 아무 동작 없음 (사용자에게 방해하지 않음)
- **FR-4**: SSH 연결이 완전히 성립된 후에만 검사 (타이밍 안정성)

## 영향 분석 (Dry-Run)

| 파일 | 변경 유형 | 리스크 | 설명 |
|------|-----------|--------|------|
| `src/App.tsx` | 수정 | Medium | `handleConnectHost`에 auto-claude-split 로직 추가 |
| `src/stores/workspace.ts` | 수정 | Medium | `addWorkspace`의 반환값 활용 + `splitLeafWithCommand` 헬퍼 추가 |
| `src/components/Terminal.tsx` | 수정 | Medium | PTY spawn 후 SSH ready 이벤트 emit |
| `src-tauri/src/lib.rs` | 수정 | Medium | `check_remote_command` Tauri command 추가 |
| `src-tauri/src/pty.rs` | 수정 | Low | PTY output 버퍼링/검사 유틸 (선택적) |

### Destructive 작업: 없음

## 코드베이스 분석

### 현재 SSH 연결 흐름

```
User clicks host -> handleConnectHost(host)
  -> buildSshCommand(host) = "ssh [-p port] [-i key] user@host"
  -> addWorkspace(host.name, sshCommand) -> 새 workspace 생성
  -> LeafNode { command: sshCommand } 로 저장
  -> Terminal.tsx: initTerminal()
    -> spawnCommand = leaf.command (= SSH 명령)
    -> invoke("spawn_pty", { command: spawnCommand })
    -> SSH 프로세스 실행, PTY로 입출력
```

### 재사용 가능한 기존 패턴

1. **`splitLeaf(workspaceId, leafId, direction)`** - 기존 split 메커니즘. 새 leaf에 `cloneFromPtyId` 설정
2. **`buildSshCommand(host)`** - SSH 명령 빌더
3. **`parseSshTarget(cmd)`** - SSH 대상 user@host 추출
4. **Monitor의 SSH 명령 실행** - `monitor.rs`가 이미 원격 명령 실행/응답 파싱을 수행
5. **`get_shell_ctx`** - PTY의 SSH 상태 감지

### 핵심 과제: SSH 연결 준비 감지

SSH가 "준비됨"을 알 수 있는 방법:
- **Option A**: PTY output에서 shell prompt 감지 (복잡, unreliable - 다양한 prompt 형식)
- **Option B**: 일정 시간 후 `get_shell_ctx`로 SSH 상태 확인 (기존 패턴)
- **Option C**: 별도 SSH 연결로 `which claude` 실행 (가장 안정적, 독립적)
- **Option D**: PTY에 `which claude` 작성 후 output 파싱 (터미널에 노이즈)

**선택: Option C** - 별도 SSH 프로세스로 `which claude` 또는 `command -v claude` 실행

이유:
- 기존 PTY 세션에 영향 없음 (사용자 터미널에 노이즈 없음)
- SSH 연결 준비를 기다릴 필요 없음 (별도 연결이므로 자체적으로 대기)
- `monitor.rs`에 이미 유사한 패턴 존재 (SSH로 명령 실행 + 결과 파싱)
- 실패해도 사용자에게 영향 없음

## 구현 순서

### Phase 1: Backend - 원격 명령 존재 확인 Tauri command

**Goal**: Rust 백엔드에서 SSH로 원격 서버의 `claude` CLI 존재 여부를 확인하는 command 추가

**Risk**: Medium (기존 코드 수정)

- [ ] **Task 1.1**: `src-tauri/src/lib.rs`에 `check_remote_command` Tauri command 추가
  ```rust
  #[tauri::command]
  async fn check_remote_command(ssh_target: String, command_name: String) -> Result<bool, String>
  ```
  - `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new user@host "command -v claude"`
  - exit code 0 = true, 그 외 = false
  - SSH host의 port/key 정보도 전달 필요 -> SSH command 전체를 받는 것이 낫다

- [ ] **Task 1.2**: 실제 구현 - SSH command 기반으로 원격 확인
  ```rust
  #[tauri::command]
  async fn check_remote_claude(ssh_command: String) -> Result<bool, String>
  ```
  - `ssh_command`에서 ssh 바이너리와 인수들을 파싱
  - 원래 SSH 명령에 `-o ConnectTimeout=10 -o BatchMode=yes` 추가
  - `-t` 대신 non-interactive로 `"command -v claude 2>/dev/null"` 실행
  - `command -v`는 POSIX 호환, `which`보다 안정적

- [ ] **Task 1.3**: `invoke_handler`에 `check_remote_claude` 등록

### Phase 2: Frontend - Auto split 로직

**Goal**: SSH 연결 시 자동으로 claude 확인 + 분할

**Risk**: Medium (기존 흐름 수정)

- [ ] **Task 2.1**: `src/stores/workspace.ts`에 `splitLeafWithCommand` 추가
  - 기존 `splitLeaf`과 유사하되, 새 leaf에 `command`를 직접 설정
  - `cloneFromPtyId` 대신 명시적 command 전달
  ```typescript
  splitLeafWithCommand: (workspaceId: string, leafId: string, direction: SplitDirection, command: string) => string;
  ```

- [ ] **Task 2.2**: `src/App.tsx`의 `handleConnectHost` 수정
  - `addWorkspace` 호출 후, 비동기로 `check_remote_claude` 실행
  - claude가 있으면 `splitLeafWithCommand`로 분할
  - 새 pane의 명령: `ssh -t [-p port] [-i key] user@host "claude --dangerously-skip-permissions"`
    - `-t`는 PTY 할당 필수 (claude가 터미널 필요)

- [ ] **Task 2.3**: Claude pane SSH 명령 빌드 헬퍼
  - `buildSshCommand`를 확장하거나 별도 함수로 원격 명령 실행용 SSH 구성
  ```typescript
  export const buildSshCommandWithRemoteCmd = (host: SshHost, remoteCmd: string): string => {
    const parts: string[] = ["ssh", "-t"];
    if (host.port !== 22) parts.push("-p", String(host.port));
    if (host.keyPath) parts.push("-i", host.keyPath);
    parts.push(`${host.user}@${host.host}`);
    parts.push(`"${remoteCmd}"`);
    return parts.join(" ");
  };
  ```

- [ ] **Task 2.4**: 타이밍/레이스 컨디션 처리
  - `addWorkspace` 반환값으로 `workspaceId` 획득
  - workspace의 첫 leaf는 layout.id로 접근 (leaf가 workspace와 동시 생성)
  - `check_remote_claude`는 SSH 접속 자체가 시간이 걸리므로, workspace가 이미 생성된 후 결과 도착
  - workspace가 그 사이에 닫혔을 수 있으므로 존재 여부 확인 후 split

### Phase 3: Edge cases & Polish

**Goal**: 안정성 보장

**Risk**: Low

- [ ] **Task 3.1**: 중복 실행 방지
  - 같은 workspace에 대해 claude 확인이 이미 진행 중이면 스킵
  - `Set<workspaceId>` 또는 `Map<workspaceId, AbortController>` 로 추적

- [ ] **Task 3.2**: SshHost에 `autoClaudeSplit` 옵션 추가 (선택)
  - 호스트별로 auto-split 활성화/비활성화 토글
  - 기본값: true (활성화)
  - SshHostPanel UI에 체크박스 추가

- [ ] **Task 3.3**: 사용자가 이미 수동으로 claude pane을 열었다면 중복 방지
  - workspace의 기존 leaf들 중 command에 "claude" 포함된 것이 있으면 스킵

- [ ] **Task 3.4**: 에러 핸들링
  - SSH 연결 실패 (timeout, auth fail): 무시 (로그만)
  - claude check 실패: 무시 (로그만)
  - split 실패: 무시 (로그만)

## 상세 설계

### Rust: `check_remote_claude` 구현

```rust
#[tauri::command]
async fn check_remote_claude(ssh_command: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_remote_claude_sync(&ssh_command)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))
}

fn check_remote_claude_sync(ssh_command: &str) -> bool {
    // Parse the SSH command to extract: ssh [-p port] [-i key] user@host
    let parts = shell_words_parse(ssh_command);
    
    let mut cmd = Command::new(&parts[0]); // "ssh"
    
    // Forward port/key args, add batch mode options
    let mut i = 1;
    while i < parts.len() {
        match parts[i].as_str() {
            "-p" | "-i" => {
                cmd.arg(&parts[i]);
                if i + 1 < parts.len() {
                    cmd.arg(&parts[i + 1]);
                    i += 2;
                    continue;
                }
            }
            s if s.contains("@") => {
                // This is the user@host target
                cmd.arg(s);
            }
            _ => {
                cmd.arg(&parts[i]);
            }
        }
        i += 1;
    }
    
    cmd.args([
        "-o", "ConnectTimeout=10",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "command -v claude 2>/dev/null",
    ]);
    
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null());
    
    match cmd.status() {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}
```

**주의**: `command -v claude 2>/dev/null`는 SSH의 원격 명령 인수로 전달되어야 한다. SSH command line에서 마지막 인수가 원격 실행 명령이 된다.

### TypeScript: handleConnectHost 수정 후 흐름

```typescript
const handleConnectHost = useCallback((host: SshHost) => {
  const cmd = buildSshCommand(host);
  const wsId = addWorkspace(host.name, cmd);
  
  // Monitor 시작 (기존 로직)
  const target = `${host.user}@${host.host}`;
  const monitorId = `mon-${Date.now()}`;
  setSidebarMonitor((prev) => {
    if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
    return { monitorId, sshTarget: target };
  });
  monitorTargetRef.current = target;
  
  // Auto claude split (비동기, fire-and-forget)
  (async () => {
    try {
      const hasClaude = await invoke<boolean>("check_remote_claude", { sshCommand: cmd });
      if (!hasClaude) return;
      
      // workspace가 아직 존재하는지 확인
      const state = useWorkspaceStore.getState();
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;
      
      // 이미 claude pane이 있는지 확인
      const hasClaudePane = /* leaf 순회하여 command에 claude 포함 확인 */;
      if (hasClaudePane) return;
      
      // Claude pane용 SSH 명령 구성
      const claudeCmd = buildSshCommandWithRemoteCmd(host, "claude --dangerously-skip-permissions");
      
      // 첫 번째 leaf의 ID 획득 (단일 leaf workspace이므로 layout이 leaf)
      const leafId = ws.layout.type === "leaf" ? ws.layout.id : ws.focusedLeafId;
      
      // 수평 분할 + claude 실행
      useWorkspaceStore.getState().splitLeafWithCommand(wsId, leafId, "horizontal", claudeCmd);
    } catch {
      // 무시 - claude 확인 실패는 사용자에게 영향 없음
    }
  })();
}, [addWorkspace]);
```

### SSH 명령 형식

- **일반 SSH pane**: `ssh -p 22 -i ~/.ssh/key user@host`
- **Claude pane**: `ssh -t -p 22 -i ~/.ssh/key user@host "claude --dangerously-skip-permissions"`
  - `-t`: pseudo-terminal 강제 할당 (claude CLI가 interactive terminal 필요)
  - 따옴표로 감싼 원격 명령

### PTY에서의 명령 파싱

`pty.rs`의 `shell_words_parse`가 따옴표를 처리하므로:
- `ssh -t user@host "claude --dangerously-skip-permissions"` 
- -> `["ssh", "-t", "user@host", "claude --dangerously-skip-permissions"]`
- -> `Command::new("ssh").arg("-t").arg("user@host").arg("claude --dangerously-skip-permissions")`

이것은 정확히 올바른 동작이다. SSH는 마지막 인수를 원격 명령으로 해석한다.

## Quality Gate

```bash
# Rust
rtk cargo check
rtk cargo clippy

# TypeScript
rtk tsc --noEmit

# Cross-layer contract
# 1. check_remote_claude: sshCommand (TS) -> ssh_command (Rust) - camelCase 자동 변환
# 2. splitLeafWithCommand: 새 store 함수 시그니처 확인
```

## 주의사항

### 타이밍

- `check_remote_claude`는 SSH 접속 + `command -v` 실행까지 수 초 소요
- 이 시간 동안 사용자는 이미 SSH 터미널을 사용 중
- split이 갑자기 발생하면 터미널 크기 변경으로 약간의 UI 깜빡임 가능
- 허용 가능한 수준으로 판단 (첫 연결 시 1회만)

### BatchMode=yes

- SSH 키 인증이 아닌 비밀번호 인증 호스트에서는 `BatchMode=yes`로 인해 실패
- 비밀번호 인증 호스트에서는 claude 검사가 불가 -> auto-split 안 됨
- 사용자가 수동으로 split 가능하므로 허용 가능

### 보안

- `--dangerously-skip-permissions`는 사용자가 의도적으로 원하는 기능
- 향후 설정에서 이 플래그를 커스터마이징할 수 있도록 확장 가능

### 잠재적 이슈

1. SSH agent forwarding이 필요한 경우 별도 처리 필요할 수 있음
2. Jump host (ProxyJump) 환경에서 `check_remote_claude` 타임아웃 가능성
3. 매우 느린 네트워크에서 ConnectTimeout=10 초과 가능 -> 15초로 조정 고려

## Implementation Notes

_(dev 에이전트가 작업 중 기록)_
