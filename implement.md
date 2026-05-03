# Implementation Notes: Phase 9 — SSH 직접 실행 + 시스템 모니터링 패널

## 변경 요약

### Step 1: SSH 직접 실행

**pty.rs** — `spawn()` 시그니처 변경:
- `spawn(app, rows, cols)` → `spawn(app, rows, cols, command: Option<String>)`
- `command`가 `Some`이면 `shell_words_parse()`로 파싱 후 `CommandBuilder`에 직접 설정
- `shell_words_parse()`: 따옴표/이스케이프를 고려한 간단한 셸 워드 분리 함수 추가

**lib.rs** — `spawn_pty` Tauri 커맨드에 `command: Option<String>` 파라미터 추가

**Terminal.tsx** — SSH 복제/복원 로직 전면 변경:
- Before: `spawn_pty()` → `setTimeout(500ms)` → `write_pty(sshCmd)`
- After: `spawn_pty({ command: sshCmd })` 단일 호출
- PowerShell 프롬프트가 잠깐 보이는 문제 해결
- `setTimeout` + `write_pty` 패턴 제거

**workspace.ts** — `LeafNode`에 `command?: string` 필드 추가, 세션 저장/복원 보존

### Step 2: 모니터링 백엔드

**monitor.rs** (신규) — `MonitorManager` 구조체:
- `start(app, monitor_id, ssh_target)`: 별도 스레드에서 5초 간격 SSH 데이터 수집
- 단일 SSH 호출로 모든 데이터 수집 (delimiter 기반 섹션 분리)
- `/proc/stat` CPU 계산 (두 스냅샷 diff), `/proc/meminfo` 파싱, `ps aux` Top-10
- `monitor-data` Tauri 이벤트로 프론트엔드에 JSON 전달
- `stop(monitor_id)`: stop flag로 스레드 정리

**lib.rs** — `start_monitor`, `stop_monitor` Tauri 커맨드 등록, `MonitorManager` managed state

### Step 3: 모니터링 프론트엔드

**uplot** 의존성 추가 (~20KB)

**workspace.ts** — `MonitorNode` 타입 추가:
- `LayoutNode = SplitNode | LeafNode | BrowserNode | MonitorNode`
- `openMonitor(wsId, leafId, sshTarget)`: vertical split, ratio 0.7 (터미널 70%, 모니터 30%)
- 세션 저장/복원, 트리 순회 함수 전부 업데이트

**monitor.ts** (신규) — Zustand 스토어:
- monitorId별 시계열 데이터 보관 (최대 60개 = 5분)
- `pushSnapshot`, `clearMonitor` 액션

**MonitorPane.tsx** (신규) — 모니터링 UI:
- 상단 바: hostname + load average
- uPlot 차트 2개: CPU% 시계열 (파란색), MEM% 시계열 (초록색)
- 프로세스 테이블: PID, USER, CPU%, MEM%, COMMAND
- Catppuccin Mocha 테마 적용
- 마운트/언마운트 시 자동 start/stop monitor

**SplitPane.tsx** — `node.type === "monitor"` 디스패치 추가

**App.tsx** — `Ctrl+Shift+M` 단축키:
- 포커스된 패인의 SSH 컨텍스트 감지 → `user@host` 파싱 → 모니터링 패인 열기
- 모니터 패인 닫기 시 `stop_monitor` 호출

## 핵심 결정

1. **SSH 실행 방식**: `portable-pty` CommandBuilder로 직접 실행. 별도 SSH 라이브러리 불필요.
2. **모니터 데이터 수집**: 별도 SSH 프로세스 (5초 간격). ControlMaster 대신 단순한 접근.
3. **차트 라이브러리**: uPlot (20KB, 60fps). recharts (400KB) 대비 20배 경량.
4. **SSH 인증**: `BatchMode=yes`로 키 인증만 지원. 비밀번호 프롬프트 없이 실패 시 에러 표시.

## 빌드 확인

- `cargo check`: ✓
- `tsc --noEmit`: ✓
- `pnpm tauri build --debug`: ✓ (바이너리 생성 완료)

## 2026-04-25 Design Follow-up

- `src/styles/linear.css`: logo/section/AI toolbar letter-spacing을 0으로 정리하고 card radius를 8px로 조정.
- `src/components/Sidebar.tsx`: sidebar row, badge, footer, connect bar의 chrome 색을 `--wmux-*` 변수로 전환.
- `src/components/SidebarMonitor.tsx`, `src/components/SidebarClaude.tsx`: card header/text/border/track 색을 theme CSS 변수로 전환.
- `src/App.tsx`: welcome logo의 accent와 letter-spacing을 sidebar chrome 규칙에 맞춤.
- `src/styles/linear.css`: logo/header/row/active bar/AI hover의 gradient와 glow를 제거하고 solid accent 및 flat background로 전환.
- `src/themes.ts`: 더 이상 사용하지 않는 `--wmux-accent-grad` 주입 제거.
- `src-tauri/tauri.conf.json`: `decorations`를 `false`로 전환.
- `src-tauri/capabilities/default.json`: custom titlebar용 close/minimize/start-dragging/toggle-maximize 권한 추가.
- `src/App.tsx`: `--wmux-*` theme 변수를 쓰는 32px custom titlebar와 minimize/maximize/close 버튼 추가.
- `src/styles/linear.css`: titlebar 버튼 hover/close hover 상태 추가.

## 2026-04-25 Linux Deb Build on 0.7

- 로컬 worktree snapshot을 `/home/seyeongkim/build/wmux-codex`로 전송.
- 0.7에서 `pnpm install --frozen-lockfile` 후 `pnpm tauri build --bundles deb` 실행.
- 생성된 패키지: `/home/seyeongkim/build/wmux-codex/src-tauri/target/release/bundle/deb/wmux_0.1.0_amd64.deb`.
- 설치 명령: `sudo -n apt-get install -y /home/seyeongkim/build/wmux-codex/src-tauri/target/release/bundle/deb/wmux_0.1.0_amd64.deb`.

## 2026-05-03 AI Pane Hook Leak

- `src/components/Terminal.tsx`에 leaf의 `aiKind`를 조회하는 `findAiKind` helper를 추가했다.
- `SHELL_HISTORY_HOOK` 주입 skip 조건을 `claude` 문자열 체크에서 `aiKind` 메타데이터 또는 알려진 AI CLI command 패턴(`claude`, `codex`, `gemini`, `copilot`) 체크로 바꿨다.
- 결과: AI CLI pane에서는 일반 shell history hook을 입력하지 않는다.

## 2026-05-03 Close Confirmation

- `src/App.tsx`의 close-requested handler가 먼저 `event.preventDefault()`를 호출하도록 변경했다.
- `window.confirm("wmux를 닫을까요?")`에서 승인한 경우에만 세션 저장 후 `appWindow.destroy()`를 호출한다.
- 중복 close 요청으로 확인창이 여러 번 뜨지 않도록 `promptOpen`/`closing` guard를 추가했다.

## 2026-05-03 Deployment Instructions

- `AGENTS.md`를 추가해 Linux 0.7 `.deb` 배포와 Windows desktop shortcut exe 갱신 절차를 고정했다.
- `CLAUDE.md`를 추가하고 `@AGENTS.md`만 import하도록 했다.
- 배포 후 기록 위치를 `verification.md`/`feedback.md`로 명시했다.
