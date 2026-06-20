# Plan: Agent Hook Interface

## 요약

Codex와 Claude Code의 hook 이벤트를 wmux에서 공통 인터페이스로 다루기 위한
현황 문서다. 현재 구현은 알림 중심의 1차 구현이며, resume/context 주입까지
완성된 상태는 아니다.

현재 실질 기능:

- Codex/Claude Code의 `Stop` 이벤트를 완료 알림으로 전달한다.
- Codex/Claude Code의 `PermissionRequest` 이벤트를 권한 요청 알림으로 전달한다.
- Claude Code의 `Notification` 이벤트를 사용자 주의 알림으로 전달한다.
- Codex의 `SessionStart`, `UserPromptSubmit`, `PreToolUse`는 설치되지만 현재는
  no-op에 가깝다.

참고 문서:

- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)

## 상태 범례

| 상태 | 의미 |
|------|------|
| 알림 구현 | hook 호출 시 wmux notify IPC를 전송한다. |
| 설치만 | 설정 파일에는 hook command가 들어가지만 현재 별도 동작은 없다. |
| enum만 | wmux-cli 이벤트 enum에는 있지만 설치 대상은 아니다. |
| X | 아직 wmux에서 모델링/설치/동작하지 않는다. |
| - | 해당 agent가 지원하지 않는 이벤트다. |

## 이벤트별 현황

| 이벤트 | Codex 지원 | Claude Code 지원 | wmux 설치 | wmux 상태 | 설명 |
|--------|------------|------------------|-----------|-----------|------|
| `SessionStart` | 있음 | 있음 | Codex | 설치만 | 세션 시작/재개 시점. Codex resume/context 주입 후보지만 현재 동작 없음. |
| `Setup` | - | 있음 | X | X | Claude init/maintenance 준비 단계. |
| `UserPromptSubmit` | 있음 | 있음 | Codex | 설치만 | 사용자 prompt 제출 직전. prompt 검증/context 추가 후보. |
| `UserPromptExpansion` | - | 있음 | X | X | Claude slash command 또는 MCP prompt 확장 직전. |
| `PreToolUse` | 있음 | 있음 | Codex | 설치만 | tool 실행 전. 정책 검사/차단 후보지만 현재 동작 없음. |
| `PermissionRequest` | 있음 | 있음 | Codex, Claude | 알림 구현 | 승인이 필요한 작업이 발생하면 wmux 알림을 보낸다. 향후 UI에서는 일반 완료 badge와 분리해 permission 표시가 필요하다. |
| `PermissionDenied` | - | 있음 | X | X | Claude auto mode classifier가 tool 호출을 거부했을 때. |
| `PostToolUse` | 있음 | 있음 | X | X | tool 실행 성공/완료 후. 로그, 후처리, 검증 후보. |
| `PostToolUseFailure` | - | 있음 | X | X | Claude tool 실행 실패 후. |
| `PostToolBatch` | - | 있음 | X | X | Claude 병렬 tool batch 완료 후. |
| `Notification` | - | 있음 | Claude | 알림 구현 | Claude가 사용자 입력 또는 주의 필요 상태를 알릴 때 wmux 알림을 보낸다. |
| `MessageDisplay` | - | 있음 | X | X | Claude assistant 메시지 표시 중. |
| `SubagentStart` | 있음 | 있음 | X | X | subagent 시작 시점. |
| `SubagentStop` | 있음 | 있음 | X | enum만 | wmux-cli enum에는 있지만 설치하지 않는다. |
| `TaskCreated` | - | 있음 | X | X | Claude task 생성 시점. |
| `TaskCompleted` | - | 있음 | X | X | Claude task 완료 시점. |
| `Stop` | 있음 | 있음 | Codex, Claude | 알림 구현 | agent turn 완료 시 wmux 완료 알림을 보낸다. |
| `StopFailure` | - | 있음 | X | X | Claude turn이 API 오류 등으로 실패 종료됐을 때. |
| `TeammateIdle` | - | 있음 | X | X | Claude agent team teammate가 idle로 들어가기 전. |
| `InstructionsLoaded` | - | 있음 | X | X | Claude가 CLAUDE.md 또는 rules 파일을 context에 로드했을 때. |
| `ConfigChange` | - | 있음 | X | X | Claude 설정 파일 변경 시점. |
| `CwdChanged` | - | 있음 | X | X | Claude 작업 디렉터리 변경 시점. |
| `FileChanged` | - | 있음 | X | X | Claude watched file 변경 시점. |
| `WorktreeCreate` | - | 있음 | X | X | Claude worktree 생성 시점. |
| `WorktreeRemove` | - | 있음 | X | X | Claude worktree 제거 시점. |
| `PreCompact` | 있음 | 있음 | X | X | context compaction 전. |
| `PostCompact` | 있음 | 있음 | X | X | context compaction 후. |
| `Elicitation` | - | 있음 | X | X | MCP 서버가 사용자 입력을 요청할 때. `AskUserRequest`라고 부르는 흐름이 있다면 이 이벤트가 가장 가까운 후보다. |
| `ElicitationResult` | - | 있음 | X | X | MCP elicitation에 사용자가 응답한 뒤. |
| `SessionEnd` | - | 있음 | X | enum만 | wmux-cli enum에는 있지만 설치하지 않는다. |

## 현재 구현

`wmux-cli`는 agent별 adapter를 통해 hook 동작을 분리한다.

- `CodexHookAdapter`
  - 설치 이벤트: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreToolUse`,
    `PermissionRequest`
  - 알림 이벤트: `Stop`, `PermissionRequest`
  - `~/.codex/hooks.json`에 hook을 설치하고, `~/.codex/config.toml`의
    `[features] hooks = true`를 보장한다.

- `ClaudeHookAdapter`
  - 설치 이벤트: `Stop`, `PermissionRequest`, `Notification`
  - 알림 이벤트: `Stop`, `PermissionRequest`, `Notification`
  - `~/.claude/settings.json`에 hook을 설치한다.
  - resume hook 주입은 아직 구현하지 않는다.

설치 시 기존 설정 전체를 덮어쓰지 않는다. `wmux-cli hooks <agent> ...` 형태의
wmux 소유 hook만 제거한 뒤 현재 버전의 hook을 다시 추가한다.

## 알림 정책

| 이벤트 | Codex 알림 | Claude Code 알림 |
|--------|------------|------------------|
| `Stop` | title `Codex`, body는 payload `message`/`summary` 또는 `Prompt completed` | title `Claude Code`, body는 payload `message`/`summary` 또는 `Prompt completed` |
| `PermissionRequest` | title `Codex`, body는 `Permission requested: ...` | title `Claude Code`, body는 `Permission requested: ...` |
| `Notification` | - | title `Claude Code`, body는 payload `message`/`body`/`text` 또는 `Needs attention` |

hook command는 `WMUX_SURFACE_ID`가 있을 때만 wmux로 알림을 보낸다. 따라서 wmux
안에서 실행된 Codex/Claude Code 세션만 알림 대상이고, 일반 터미널에서 실행된
세션은 hook이 호출되어도 `{}`만 반환한다.

## 남은 작업

1. `PermissionRequest`를 일반 완료 알림 숫자와 분리해 권한/승인 아이콘으로 표시한다.
2. Codex `SessionStart` 기반 resume/context 주입을 구현한다.
3. 공통 이벤트인 `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`,
   `SubagentStop`를 adapter 모델에 추가할지 결정한다.
4. Claude Code의 `Elicitation`을 사용자 입력 요청 알림으로 처리할지 검토한다.
