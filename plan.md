# wmux - Windows Terminal for AI Agents

> cmux의 Windows 대안. Tauri v2 + React + xterm.js 기반.

## 아키텍처

```
┌─────────────────────────────────────────────────┐
│                    wmux Window                   │
│ ┌──────────┐ ┌────────────────────────────────┐ │
│ │ Sidebar  │ │         Main Area              │ │
│ │          │ │ ┌────────────┬───────────────┐ │ │
│ │ [ws1] ●  │ │ │ Terminal 1 │  Terminal 2   │ │ │
│ │  main    │ │ │ (xterm.js) │  (xterm.js)   │ │ │
│ │  :3000   │ │ │            │               │ │ │
│ │          │ │ ├────────────┴───────────────┤ │ │
│ │ [ws2]    │ │ │      Terminal 3            │ │ │
│ │  feat/x  │ │ │      (xterm.js)            │ │ │
│ │          │ │ └────────────────────────────┘ │ │
│ └──────────┘ └────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## 기술 스택

| 레이어 | 기술 | 이유 |
|--------|------|------|
| 프레임워크 | Tauri v2 | 경량, Rust 백엔드, WebView2 |
| 프론트엔드 | React + TypeScript | 생태계, 컴포넌트 모델 |
| 스타일링 | Tailwind CSS | 빠른 UI 개발 |
| 터미널 | xterm.js + WebGL addon | 성능, 표준 |
| PTY | portable-pty 또는 tauri-plugin-pty | 검증된 ConPTY 래퍼 |
| 상태관리 | Zustand | 경량, TypeScript 친화적 |
| 빌드 | Vite | 빠른 HMR |

## 구현 단계

### Phase 1: 기본 터미널 (MVP)
> 목표: xterm.js가 Windows 셸에 연결된 단일 터미널 창

1. **프로젝트 초기화**
   - `pnpm create tauri-app wmux --template react-ts`
   - Vite + React + TypeScript 설정
   - Tailwind CSS 추가

2. **PTY 백엔드 (Rust)**
   - `portable-pty` 또는 `tauri-plugin-pty` 통합
   - Tauri command: `spawn_shell`, `write_to_pty`, `resize_pty`
   - PTY stdout → Tauri event로 프론트엔드에 전달

3. **터미널 프론트엔드**
   - xterm.js + fit addon + webgl addon
   - Tauri event 수신 → `terminal.write()`
   - `terminal.onData()` → Tauri command로 PTY에 전달
   - 창 리사이즈 대응

4. **기본 UI 셸**
   - 타이틀바 (Tauri 커스텀 타이틀바)
   - 단일 터미널 뷰

**산출물**: PowerShell/cmd/bash가 동작하는 터미널 앱

---

### Phase 2: Workspace + 탭
> 목표: 사이드바에서 여러 작업 공간 관리

5. **Workspace 모델**
   - Zustand store: workspaces[], activeWorkspaceId
   - Workspace = { id, name, shells[], cwd }

6. **사이드바 UI**
   - 왼쪽 세로 탭 리스트
   - Workspace 이름, 활성 표시
   - 새 Workspace 추가/닫기 버튼
   - Workspace 이름 편집 (더블클릭)

7. **다중 터미널 인스턴스**
   - Workspace 전환 시 터미널 인스턴스 보존 (display:none 토글)
   - 각 Workspace에 독립 PTY 프로세스

**산출물**: 사이드바로 여러 터미널 세션 전환

---

### Phase 3: Split Panes
> 목표: 하나의 Workspace 안에서 터미널 분할

8. **분할 레이아웃 엔진**
   - 트리 기반 레이아웃 (Binary Split Tree)
   - Node = { type: 'split', direction: 'h'|'v', children, ratio }
   - Leaf = { type: 'terminal', ptyId }

9. **분할 UI**
   - 드래그로 비율 조절
   - 키보드 단축키: `Ctrl+Shift+D` (수직), `Ctrl+Shift+E` (수평)
   - 패인 간 포커스 이동: `Alt+방향키`
   - 비활성 패인 투명도 조절

10. **패인 생명주기**
    - 분할 시 새 PTY 생성
    - 닫기 시 PTY 종료 + 레이아웃 리밸런싱

**산출물**: 자유롭게 분할 가능한 터미널 레이아웃

---

### Phase 4: 사이드바 메타데이터
> 목표: git/포트/알림 정보를 사이드바에 자동 표시

11. **Git 정보 수집 (Rust)**
    - 주기적으로 `git branch --show-current` 실행
    - `gh pr list --head <branch>` 로 PR 상태 (gh CLI 설치 시)
    - cwd 감지: PTY 프로세스의 작업 디렉토리 추적

12. **포트 감지 (Rust)**
    - `netstat` 파싱 또는 Windows API로 리스닝 포트 탐지
    - PTY 자식 프로세스 PID 기준으로 필터링

13. **사이드바 업데이트**
    - Workspace별: branch명, PR #, cwd 마지막 폴더, 포트 목록
    - 실시간 Tauri event로 프론트엔드 갱신

**산출물**: 사이드바에 컨텍스트 정보 자동 표시

---

### Phase 5: 알림 시스템
> 목표: Claude Code 등 AI 에이전트의 알림 수신/표시

14. **알림 모델**
    - Notification = { id, title, body, workspaceId, status, timestamp }
    - 상태: received → unread → read → cleared

15. **알림 수신**
    - OSC 777 시퀀스 파싱 (xterm.js 커스텀 파서)
    - 환경변수 `WMUX_WORKSPACE_ID`, `WMUX_SURFACE_ID` 주입

16. **알림 UI**
    - 사이드바 배지 (미읽음 카운트)
    - Windows 토스트 알림 (winrt-notification 크레이트)
    - 알림 패널 (오버레이)

17. **Claude Code Hook 연동**
    - `~/.claude/settings.json`에 Hook 등록 가이드
    - `wmux notify` CLI 명령어

**산출물**: AI 에이전트 작업 완료 알림

---

### Phase 6: CLI
> 목표: `wmux` 명령어로 외부에서 제어

18. **IPC 서버 (Rust)**
    - Named Pipe (Windows) 기반 IPC
    - JSON-RPC 프로토콜
    - Tauri 앱 시작 시 파이프 서버 생성

19. **CLI 바이너리**
    - 별도 Rust 바이너리 (`wmux-cli`)
    - Named Pipe 클라이언트
    - 주요 명령어:
      - `wmux list-workspaces / new-workspace / select-workspace`
      - `wmux new-split right/down`
      - `wmux send "텍스트"` / `wmux send-key enter`
      - `wmux notify --title "T" --body "B"`
      - `wmux set-status / set-progress`

20. **PATH 등록**
    - 설치 시 CLI를 시스템 PATH에 추가

**산출물**: 외부 스크립트/에이전트에서 wmux 제어 가능

---

### Phase 7: 내장 브라우저
> 목표: 터미널 옆에 웹 브라우저 패인

21. **브라우저 패인**
    - Tauri WebView를 추가 패인으로 렌더링
    - Split Tree의 Leaf 타입에 `browser` 추가
    - URL 바 + 네비게이션 버튼

22. **브라우저 자동화 API**
    - CLI: `wmux browser navigate <url>`
    - `wmux browser snapshot` (접근성 트리)
    - JS evaluate, click, fill 등

**산출물**: 터미널과 브라우저를 나란히 사용

---

### Phase 8: 설정 & 마감
> 목표: 사용자 커스터마이징, 세션 복원

23. **설정 시스템**
    - `~/.wmux/config.toml`
    - 폰트, 테마, 색상, 셸 경로, 단축키
    - 설정 UI (Settings 탭)

24. **세션 복원**
    - 종료 시 레이아웃/cwd 저장 (`~/.wmux/sessions/`)
    - 재시작 시 복원

25. **테마**
    - Ghostty 테마 파일 호환 (가능한 범위)
    - 기본 내장 테마 몇 개

---

## 우선순위 요약

| Phase | 핵심 가치 | 예상 규모 |
|-------|-----------|-----------|
| 1. 기본 터미널 | 동작하는 터미널 | 중 |
| 2. Workspace + 탭 | 다중 세션 | 중 |
| 3. Split Panes | 화면 분할 | 중~대 |
| 4. 사이드바 메타 | cmux 핵심 차별화 | 중 |
| 5. 알림 | AI 에이전트 통합 | 중 |
| 6. CLI | 자동화/스크립팅 | 대 |
| 7. 브라우저 | 고급 기능 | 대 |
| 8. 설정 & 마감 | 완성도 | 중 |

### Phase 9: SSH 직접 실행 + 시스템 모니터링 패널
> 목표: SSH를 PTY로 직접 실행 (중간 셸 제거) + 원격 서버 모니터링 대시보드

#### Step 1: SSH 직접 실행 (기능 A)

**문제**: 현재 SSH 세션 복제/복원 시 PowerShell을 먼저 띄운 뒤 500ms 후 SSH 명령을 타이핑.
**해결**: `spawn_pty`에 `command` 파라미터를 추가하여 SSH를 PTY 프로세스로 직접 실행.

1-1. **Rust: `PtyManager::spawn()` 확장** — `pty.rs`
   - `spawn(app, rows, cols)` → `spawn(app, rows, cols, command: Option<String>)`
   - `command`가 `Some`이면 해당 명령어를 파싱하여 `CommandBuilder`에 설정
   - `command`가 `None`이면 기존 동작 (PowerShell)
   ```rust
   // command = Some("ssh user@host -t bash")
   // → CommandBuilder::new("ssh").args(["user@host", "-t", "bash"])
   ```

1-2. **Rust: Tauri 커맨드 수정** — `lib.rs`
   - `spawn_pty(app, state, rows, cols)` → `spawn_pty(app, state, rows, cols, command: Option<String>)`
   - 기존 호출부(`command` 미전달)는 `None`으로 하위호환

1-3. **TS: 터미널 초기화 수정** — `Terminal.tsx`
   - `spawn_pty` invoke에 `command` 파라미터 추가
   - SSH 복제 로직 변경:
     ```
     Before: spawn_pty() → setTimeout(500ms) → write_pty(sshCmd)
     After:  spawn_pty({ command: sshCmd })
     ```
   - SSH 세션 복원 로직도 동일하게 변경
   - `setTimeout(500ms)` + `write_pty` 패턴 제거

1-4. **TS: 세션 저장/복원 확장** — `workspace.ts`
   - `LeafNode`에 `command?: string` 필드 추가
   - `SavedLeaf`에 `command?: string` 추가
   - `stripPty()`, `restoreLayout()`에서 `command` 보존

**검증**:
- [x] 기존 터미널 생성 (command 없음) → PowerShell 실행 (기존 동작)
- [x] SSH 복제 (command="ssh user@host") → SSH 직접 실행
- [x] 세션 저장/복원 시 command 보존
- [x] `tsc --noEmit` + `cargo check` 통과

---

#### Step 2: 모니터링 백엔드 (기능 B-Backend)

2-1. **Rust: 모니터링 모듈** — `src-tauri/src/monitor.rs` (신규)
   - `MonitorManager` 구조체: 활성 모니터링 세션 관리
   - `start_monitor(ssh_target, monitor_id)`:
     - 별도 스레드에서 5초 간격으로 SSH 명령 실행
     - 단일 SSH 호출로 모든 데이터 수집:
       ```bash
       ssh {target} 'echo "===STAT===" && cat /proc/stat && echo "===MEM===" && cat /proc/meminfo && echo "===LOAD===" && cat /proc/loadavg && echo "===PS===" && ps aux --sort=-%cpu | head -21'
       ```
     - 출력을 구분자(===STAT=== 등)로 분리 → 각 섹션 파싱
     - `monitor-data` Tauri 이벤트로 프론트엔드에 전달
   - `stop_monitor(monitor_id)`: 스레드 중단 플래그 설정
   - 파싱 결과 구조체:
     ```rust
     struct MonitorData {
         monitor_id: String,
         cpu_percent: f64,          // /proc/stat 두 스냅샷 diff
         mem_total_mb: u64,
         mem_used_mb: u64,
         mem_percent: f64,
         load_avg: [f64; 3],        // 1, 5, 15분
         processes: Vec<ProcessInfo>, // pid, user, cpu%, mem%, command
         timestamp: u64,
     }
     ```

2-2. **Rust: Tauri 커맨드 등록** — `lib.rs`
   - `start_monitor(ssh_target, monitor_id)` 커맨드 추가
   - `stop_monitor(monitor_id)` 커맨드 추가
   - `MonitorManager`를 `.manage()` 상태로 등록

**검증**:
- [x] `cargo check` 통과
- [x] SSH 키 인증된 서버에서 데이터 수집 확인
- [x] `monitor-data` 이벤트 발행 확인

---

#### Step 3: 모니터링 프론트엔드 (기능 B-Frontend)

3-1. **의존성 추가** — `package.json`
   - `pnpm add uplot`

3-2. **TS: MonitorNode 타입** — `workspace.ts`
   - `MonitorNode` 인터페이스 추가:
     ```typescript
     interface MonitorNode {
       type: "monitor";
       id: string;
       sshTarget: string;   // "user@host"
       monitorId: string;    // 백엔드 모니터 세션 ID
     }
     ```
   - `LayoutNode` 유니온에 `MonitorNode` 추가
   - 트리 순회 함수 업데이트: `collectLeafIds`, `removeLeaf`, `replaceNode`
   - 세션 저장/복원: `SavedMonitor` 타입 추가
   - `openMonitor(wsId, leafId, sshTarget)` 액션 추가

3-3. **TS: 모니터 데이터 스토어** — `src/stores/monitor.ts` (신규)
   - `MonitorDataStore`: monitorId별 시계열 데이터 보관
   - 최근 60개 포인트 유지 (5초 × 60 = 5분 히스토리)
   - `monitor-data` 이벤트 리스너에서 데이터 추가

3-4. **TS: MonitorPane 컴포넌트** — `src/components/MonitorPane.tsx` (신규)
   - 레이아웃:
     ```
     ┌──────────────────────────────┐
     │  hostname  │  uptime  │ load │  ← 상단 바
     ├──────────────────────────────┤
     │  CPU Usage (uPlot line)      │  ← CPU 시계열
     ├──────────────────────────────┤
     │  Memory Usage (uPlot line)   │  ← 메모리 시계열
     ├──────────────────────────────┤
     │  PID  USER  CPU%  MEM%  CMD  │  ← 프로세스 테이블
     │  ...                         │
     └──────────────────────────────┘
     ```
   - uPlot 래퍼: `useRef` + `useEffect`로 차트 인스턴스 관리
   - Catppuccin 테마에 맞춘 차트 색상
   - 마운트 시 `start_monitor` invoke, 언마운트 시 `stop_monitor`

3-5. **TS: SplitPane 디스패치** — `SplitPane.tsx`
   - `node.type === "monitor"` 분기 추가 → `<MonitorPane />`

3-6. **TS: 키보드 단축키** — `App.tsx`
   - `Ctrl+Shift+M`: 현재 포커스된 패인의 SSH 타겟을 감지 → 모니터링 패인 열기
   - SSH 세션이 아닌 경우 무시

**검증**:
- [x] `tsc --noEmit` 통과
- [x] 모니터링 패인 열기/닫기 동작
- [x] uPlot 차트 실시간 갱신
- [x] 세션 저장/복원 시 모니터 패인 복원

---

#### Step 4: 통합 및 UX

4-1. **SSH 타겟 자동 감지**
   - 포커스된 패인이 SSH 세션일 때 `get_shell_ctx`로 SSH 명령 추출
   - SSH 명령에서 `user@host` 파싱 (포트 번호 등 옵션 처리)

4-2. **모니터링 패인 자동 배치**
   - `Ctrl+Shift+M` → 현재 패인을 vertical split → 하단에 모니터링 패인
   - ratio 기본값 0.7 (터미널 70%, 모니터 30%)

4-3. **모니터링 상태 표시**
   - 연결 실패 시 에러 메시지 표시
   - SSH 키 인증 실패 시 안내 메시지
   - 수집 중단 시 마지막 데이터에 "stale" 표시

---

#### 변경 파일 요약

| 파일 | 변경 유형 | Step |
|------|----------|------|
| `src-tauri/src/pty.rs` | 수정 | 1-1 |
| `src-tauri/src/lib.rs` | 수정 | 1-2, 2-2 |
| `src-tauri/src/monitor.rs` | **신규** | 2-1 |
| `src/components/Terminal.tsx` | 수정 | 1-3 |
| `src/stores/workspace.ts` | 수정 | 1-4, 3-2 |
| `src/stores/monitor.ts` | **신규** | 3-3 |
| `src/components/MonitorPane.tsx` | **신규** | 3-4 |
| `src/components/SplitPane.tsx` | 수정 | 3-5 |
| `src/App.tsx` | 수정 | 3-6 |
| `package.json` | 수정 | 3-1 |

#### 의존성 추가

- **Frontend**: `uplot` (~20KB)
- **Backend**: 추가 크레이트 없음 (SSH는 `std::process::Command`로 실행)

---

## 리스크

| 리스크 | 대응 |
|--------|------|
| ConPTY 호환성 이슈 | portable-pty가 WezTerm에서 검증됨 |
| xterm.js 한글 입력 | IME 이벤트 처리 필요, 테스트 우선 |
| PTY cwd 추적 | Windows에서 `/proc` 없음 → OSC 7 시퀀스 의존 |
| 브라우저 패인 복잡도 | Phase 7로 후순위, 생략 가능 |
| 성능 (다수 PTY) | WebGL 렌더러 + 비활성 탭 최소화 |

## 프로젝트 구조 (예상)

```
wmux/
├── src-tauri/           # Rust 백엔드
│   ├── src/
│   │   ├── main.rs
│   │   ├── pty.rs       # PTY 관리
│   │   ├── ipc.rs       # Named Pipe IPC
│   │   ├── git.rs       # Git 정보 수집
│   │   └── ports.rs     # 포트 감지
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                 # React 프론트엔드
│   ├── components/
│   │   ├── Sidebar/
│   │   ├── Terminal/
│   │   ├── SplitPane/
│   │   └── Browser/
│   ├── stores/          # Zustand
│   ├── hooks/
│   └── App.tsx
├── wmux-cli/            # CLI 바이너리
│   ├── src/main.rs
│   └── Cargo.toml
├── package.json
└── vite.config.ts
```
