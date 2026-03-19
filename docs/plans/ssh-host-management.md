# SSH 호스트 등록 시스템 + 모니터링 글씨 크기 개선

## 1. 요구사항 요약

### FR-1: SSH 호스트 등록/관리
- 사이드바 또는 설정에서 SSH 호스트 목록 CRUD (이름, user, host, port, key path 등)
- 등록된 호스트 클릭 -> 새 워크스페이스 또는 패인으로 SSH 접속
- 여러 호스트를 한번에 열 수 있는 기능 (멀티 셀렉트)
- 접속과 동시에 사이드바 하단 모니터링 자동 표시

### FR-2: 사이드바 모니터링 글씨 크기 개선
- 현재 10-11px -> 가독성 있는 크기로 증가

---

## 2. 코드베이스 분석

### 기존 SSH 접속 흐름
1. 터미널에서 수동 `ssh user@host` 입력
2. `App.tsx`의 `checkSsh` (5초 폴링)이 `get_shell_ctx`로 SSH 감지
3. `parseSshTarget`으로 `user@host` 추출
4. `SidebarMonitor` 컴포넌트에 `monitorId` + `sshTarget` 전달
5. `SidebarMonitor`가 `start_monitor` Tauri command 호출
6. 백엔드 `monitor.rs`가 SSH 경유 `/proc/stat`, `/proc/meminfo` 등 수집
7. `monitor-data` 이벤트로 프론트엔드에 전송

### 기존 PTY 스폰 패턴 (command 직접 실행)
- `pty.rs::spawn()` - `command: Option<String>` 파라미터 지원
- `Terminal.tsx` - `spawnCommand`를 `spawn_pty`에 전달 (SSH 복원/클론 시 사용)
- `LeafNode.command` 필드 - 세션 저장/복원 시 직접 실행할 명령어 저장

### 설정 저장 패턴
- `localStorage` 기반 (`wmux-settings`, `wmux-session`)
- zustand 스토어 + 수동 `localStorage` 직렬화

### 모니터링 현재 글씨 크기
- `SidebarMonitor.tsx`: container `fontSize: 11`, 대부분의 라벨/값 `fontSize: 10`
- hostname `fontSize: 11`, error/loading `fontSize: 10`, bar/load/proc 전부 `fontSize: 10`

---

## 3. 영향 분석 (Dry-Run)

### 파일별 변경 테이블

| 파일 | 작업 | 리스크 | 설명 |
|------|------|--------|------|
| `src/stores/sshHosts.ts` | **NEW** | Low | SSH 호스트 목록 zustand 스토어 (CRUD, localStorage 저장) |
| `src/components/SshHostPanel.tsx` | **NEW** | Low | SSH 호스트 관리 UI (추가/편집/삭제 폼, 목록) |
| `src/components/Sidebar.tsx` | MODIFY | Medium | SSH 호스트 섹션 추가 (호스트 목록 + 클릭 접속 + 멀티 셀렉트) |
| `src/components/SidebarMonitor.tsx` | MODIFY | Low | 글씨 크기 10-11px -> 12-13px로 증가 |
| `src/App.tsx` | MODIFY | Medium | SSH 호스트 접속 핸들러, 호스트 패널 토글, 키보드 단축키 |
| `src/stores/workspace.ts` | MODIFY | Medium | `addWorkspace`에 command 파라미터 추가 (SSH 직접 실행용) |

### Destructive 작업: 없음

---

## 4. 구현 순서

### Phase 1: SSH 호스트 스토어 (Low risk)
**Goal**: SSH 호스트 데이터 모델 + CRUD + localStorage 영속화

- [x] `src/stores/sshHosts.ts` 생성
  - `SshHost` 인터페이스: `id, name, user, host, port (default 22), keyPath?, color?`
  - zustand 스토어: `hosts[], addHost, updateHost, removeHost, reorderHosts`
  - `localStorage("wmux-ssh-hosts")` 자동 저장/로드
  - SSH 커맨드 빌드 헬퍼: `buildSshCommand(host) -> string`
    - 예: `ssh -p 2222 -i ~/.ssh/id_rsa user@hostname`

### Phase 2: SSH 호스트 관리 UI (Low risk)
**Goal**: 호스트 추가/편집/삭제 폼

- [x] `src/components/SshHostPanel.tsx` 생성
  - 설정 패널과 유사한 모달/오버레이 패턴 (SettingsPanel 참고)
  - 폼 필드: Name, User, Host, Port, Key Path
  - 호스트 목록에서 편집/삭제
  - 접속 테스트 버튼 (optional, Phase 4에서)

### Phase 3: 사이드바 SSH 호스트 섹션 (Medium risk)
**Goal**: 사이드바에 등록된 호스트 목록 표시 + 클릭 접속

- [x] `src/components/Sidebar.tsx` 수정
  - 워크스페이스 목록과 푸터 사이에 SSH 호스트 섹션 추가
  - 접혀있는 섹션 (토글 가능)
  - 각 호스트: 이름 표시, 클릭 -> 접속, 우클릭 or 버튼 -> 편집
  - "Manage Hosts" 버튼 -> SshHostPanel 오픈
  - 멀티셀렉트: Ctrl+클릭으로 여러 호스트 선택 -> "Connect All" 버튼

- [x] `src/stores/workspace.ts` 수정
  - `addWorkspace(name?, command?)` 시그니처 확장
    - command가 있으면 leaf에 `command` 필드 설정
    - 새 워크스페이스 생성 시 SSH 명령어 직접 실행

- [x] `src/App.tsx` 수정
  - `SshHostPanel` 토글 state + 렌더
  - SSH 호스트 접속 핸들러: `handleConnectHost(host)` -> `addWorkspace(host.name, buildSshCommand(host))`
  - 멀티 접속 핸들러: 선택된 호스트들을 순차적으로 워크스페이스로 열기
  - 접속 시 모니터링 자동 시작: 기존 SSH 자동감지 로직이 이미 동작하므로 추가 작업 불필요
    - 이유: `checkSsh`가 `leaf.command`에서 SSH 감지 -> `parseSshTarget` -> 모니터 자동 시작

### Phase 4: 모니터링 글씨 크기 개선 (Low risk)
**Goal**: SidebarMonitor 가독성 향상

- [x] `src/components/SidebarMonitor.tsx` 수정
  - container `fontSize`: 11 -> 12
  - hostname `fontSize`: 11 -> 13
  - barLabel, barValue, loadLabel, loadValues: 10 -> 12
  - procHeader, procRow: 10 -> 11
  - error, loading: 10 -> 11
  - closeBtn: 11 -> 12
  - barTrack height: 4 -> 5
  - Sparkline height: 20 -> 24

---

## 5. Cross-Layer Interface Contract

### 변경 없는 기존 Tauri Commands (재사용)
| Command | Rust 파라미터 | TS 호출 | 상태 |
|---------|--------------|---------|------|
| `spawn_pty` | `rows: u16, cols: u16, command: Option<String>` | `invoke("spawn_pty", { rows, cols, command })` | OK - command=null 시 기본 셸 |
| `start_monitor` | `monitor_id: String, ssh_target: String` | `invoke("start_monitor", { monitorId, sshTarget })` | OK - camelCase 자동변환 |
| `stop_monitor` | `monitor_id: String` | `invoke("stop_monitor", { monitorId })` | OK |
| `get_shell_ctx` | `id: u32` | `invoke("get_shell_ctx", { id })` | OK |

### 이벤트 이름 대조
| Event | Rust emit | TS listen | 상태 |
|-------|----------|-----------|------|
| `monitor-data` | `app.emit("monitor-data", &data)` | `listen("monitor-data", ...)` | OK |
| `pty-output` | `app.emit("pty-output", ...)` | `listen("pty-output", ...)` | OK |
| `pty-exit` | `app.emit("pty-exit", ...)` | `listen("pty-exit", ...)` | OK |

**결론**: 백엔드 변경 불필요. 모든 작업이 프론트엔드에서 기존 Tauri command를 재사용하여 처리 가능.

---

## 6. Quality Gate

```bash
# TypeScript 타입 체크
rtk tsc --noEmit

# 빌드 테스트
rtk cargo check
rtk cargo build
```

---

## 7. 주의사항

### SSH 커맨드 빌드 시 주의
- Windows 경로의 `\` 이스케이프 처리 (keyPath)
- port가 22가 아닐 때만 `-p` 플래그 추가
- keyPath가 있을 때만 `-i` 플래그 추가
- `pty.rs::shell_words_parse`가 Windows에서 `\` 이스케이프를 하지 않음 (L264: `!cfg!(windows)`) -> keyPath에 Windows 경로 안전

### 모니터링 자동 시작 메커니즘
- `App.tsx`의 `checkSsh`가 `leaf.command`에서 SSH를 감지하여 자동으로 모니터 시작
- SSH 호스트 접속 시 `leaf.command`에 SSH 명령어가 설정되므로 별도 모니터 시작 로직 불필요
- 단, `checkSsh`는 5초 폴링이므로 접속 직후 최대 5초 딜레이 발생 가능

### 멀티 접속 시 UX
- 여러 호스트를 한번에 열면 각각 별도 워크스페이스로 생성
- 패인으로 열기 옵션도 고려 (현재 워크스페이스에 split으로 추가)

---

## 8. Implementation Notes

### Phase 1-4 구현 완료 (2026-03-19)

**생성된 파일:**
- `src/stores/sshHosts.ts` - SshHost 인터페이스, zustand CRUD 스토어, localStorage 영속화, buildSshCommand 헬퍼
- `src/components/SshHostPanel.tsx` - SSH 호스트 관리 모달 (추가/편집/삭제 폼, 색상 선택, 커맨드 미리보기)

**수정된 파일:**
- `src/stores/workspace.ts` - addWorkspace(name?, command?) 시그니처 확장, leaf에 command 필드 설정
- `src/components/Sidebar.tsx` - SSH 호스트 섹션 추가 (토글 가능, Ctrl+클릭 멀티셀렉트, Connect All, Manage Hosts 버튼), 푸터에 H 버튼
- `src/App.tsx` - SshHostPanel 토글, handleConnectHost 핸들러 (buildSshCommand -> addWorkspace)
- `src/components/SidebarMonitor.tsx` - fontSize 전반 증가 (10-11 -> 11-13), barTrack 높이 4->5, sparkline 높이 20->24

**주요 결정:**
- 기존 checkSsh 폴링이 leaf.command 필드에서 SSH를 자동 감지하므로 별도 모니터 시작 로직 불필요
- 멀티 접속은 각각 별도 워크스페이스로 생성 (패인 분할은 향후 확장 가능)
- tsc --noEmit 통과 확인
