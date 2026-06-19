# Plan: OS Abstraction Review

상세 계획서: `docs/plans/os-abstraction-review.md`

## 요약

15개 parallel reviewer로 전체 저장소를 검토한 결과를 정리한다.
대부분은 순수 크로스플랫폼 리팩터링 항목이라기보다 실제 버그이며,
반복 원인은 SSH/remote command 문자열 경계와 OS별 capability adapter 부재다.

---

# Plan: Auto Claude Split on SSH Connection

상세 계획서: `docs/plans/auto-claude-split.md`

## 요약

SSH 호스트 연결 시 원격 서버에 `claude` CLI가 설치되어 있으면, 자동으로 터미널을 수평 분할하여 `claude --dangerously-skip-permissions`를 별도 SSH 세션으로 실행한다. 설치되어 있지 않으면 아무 동작 없음.

## 핵심 설계 결정

1. **별도 SSH 연결로 claude 존재 확인** - 기존 PTY에 노이즈 없이 `ssh -o BatchMode=yes user@host "command -v claude"` 실행
2. **`splitLeafWithCommand` 신규 store 함수** - 기존 `splitLeaf`(cloneFromPtyId 기반)과 달리 명시적 command로 새 pane 생성
3. **fire-and-forget 비동기** - claude 확인은 `handleConnectHost` 내에서 비동기 실행, 실패해도 무시
4. **`ssh -t` + 따옴표 원격 명령** - `ssh -t user@host "claude --dangerously-skip-permissions"` 형태로 PTY 할당

## Phase 요약

| Phase | 내용 | 리스크 | 새 파일 | 수정 파일 |
|-------|------|--------|---------|-----------|
| 1 | Backend: `check_remote_claude` Tauri command | Medium | - | `lib.rs` |
| 2 | Frontend: auto split 로직 + `splitLeafWithCommand` | Medium | - | `App.tsx`, `workspace.ts`, `sshHosts.ts` |
| 3 | Edge cases: 중복 방지, 에러 핸들링 | Low | - | `App.tsx` |

## 주요 리스크

- BatchMode=yes로 인해 비밀번호 인증 호스트에서는 자동 감지 불가 (허용 가능)
- SSH 접속 시간(수 초) 동안 비동기 대기 후 split -> 약간의 UI 깜빡임
- ProxyJump/느린 네트워크에서 타임아웃 가능성

---

# Plan: Grid Overview (All Workspaces at a Glance)

상세 계획서: `docs/plans/grid-overview.md`

## 요약

모든 열린 워크스페이스를 동시에 보여주는 그리드 뷰. 각 셀에 실시간 미니어처 xterm.js 터미널을 표시하여 모든 세션을 한눈에 파악. 셀 클릭 시 해당 워크스페이스로 전환.

## 핵심 설계 결정

1. **모든 워크스페이스 항상 마운트** - 기존: active만 렌더링 -> 변경: 전체 마운트, inactive는 `display:none`
2. **CSS transform: scale()로 축소** - xterm 인스턴스 재생성 없이 CSS로 축소 표시, PTY 리사이즈 불필요
3. **WebGL 컨텍스트 제한 대응** - 8개 초과 시 자동 canvas2d 폴백 (xterm 내장 동작)
4. **xterm DOM 재사용** - 기존 코드의 appendChild 패턴(Terminal.tsx:145-157) 활용

## Phase 요약

| Phase | 내용 | 리스크 | 새 파일 | 수정 파일 |
|-------|------|--------|---------|-----------|
| 1 | 그리드 인프라 (토글, 레이아웃, 셀) | Low | `GridOverview.tsx`, `GridCell.tsx` | `App.tsx` |
| 2 | 실시간 터미널 미니어처 표시 | High | `MiniTerminal.tsx`, `MiniSplitPane.tsx` | `Terminal.tsx`, `App.tsx` |
| 3 | 폴리싱 (키보드, 애니메이션, 엣지 케이스) | Medium | - | `GridOverview.tsx`, `GridCell.tsx`, `Sidebar.tsx` |

## 주요 리스크

- WebGL 컨텍스트 제한 (8-16개): xterm 자동 폴백으로 대응
- xterm DOM reparenting 안정성: 기존 패턴 검증 완료, staggered reparent로 보강
- 10+ 워크스페이스 성능: CSS 스케일링으로 리사이즈 비용 제거

---

# (Previous) Plan: SSH Host Management

상세 계획서: `docs/plans/ssh-host-management.md`
