# Plan: Agent Hook Interface

## 요약

Codex와 Claude Code의 hook 이벤트를 wmux에서 공통 인터페이스로 다루기 위한
현황 문서다. 현재 구현은 알림과 로컬 agent 세션 복원을 다룬다. context 주입은
아직 구현하지 않는다.

현재 실질 기능:

- Codex/Claude Code의 세션 hook payload에서 session id와 cwd를 저장한다.
- experimental 옵션이 켜져 있으면 앱 재시작 시 저장된 cwd에서 해당 세션을 resume한다.
- Codex/Claude Code의 `Stop` 이벤트를 완료 알림으로 전달한다.
- Codex/Claude Code의 `PermissionRequest` 이벤트를 권한 요청 알림으로 전달한다.
- Claude Code의 `Notification` 이벤트를 사용자 주의 알림으로 전달한다.
- Codex의 `PreToolUse`는 설치되지만 현재는 no-op에 가깝다.

참고 문서:

- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)

## 상태 범례

| 상태 | 의미 |
|------|------|
| 알림 구현 | hook 호출 시 wmux notify IPC를 전송한다. |
| 세션 저장 | hook payload의 session id/cwd를 wmux session 복원 데이터에 저장한다. |
| 설치만 | 설정 파일에는 hook command가 들어가지만 현재 별도 동작은 없다. |
| enum만 | wmux-cli 이벤트 enum에는 있지만 설치 대상은 아니다. |
| X | 아직 wmux에서 모델링/설치/동작하지 않는다. |
| - | 해당 agent가 지원하지 않는 이벤트다. |

## 이벤트별 현황

| 이벤트 | Codex 지원 | Claude Code 지원 | wmux 설치 | wmux 상태 | 설명 |
|--------|------------|------------------|-----------|-----------|------|
| `SessionStart` | 있음 | 있음 | Codex, Claude | 세션 저장 | 세션 시작/재개 시점. 로컬 wmux pane의 session id와 cwd를 저장한다. |
| `Setup` | - | 있음 | X | X | Claude init/maintenance 준비 단계. |
| `UserPromptSubmit` | 있음 | 있음 | Codex, Claude | 세션 저장 | 사용자 prompt 제출 직전. 로컬 wmux pane의 최신 session id와 cwd를 갱신한다. |
| `UserPromptExpansion` | - | 있음 | X | X | Claude slash command 또는 MCP prompt 확장 직전. |
| `PreToolUse` | 있음 | 있음 | Codex | 설치만 | tool 실행 전. 정책 검사/차단 후보지만 현재 동작 없음. |
| `PermissionRequest` | 있음 | 있음 | Codex, Claude | 알림 구현 | 승인이 필요한 작업이 발생하면 wmux 알림을 보낸다. 향후 UI에서는 일반 완료 badge와 분리해 permission 표시가 필요하다. |
| `PermissionDenied` | - | 있음 | X | X | Claude auto mode classifier가 tool 호출을 거부했을 때. |
| `PostToolUse` | 있음 | 있음 | X | X | tool 실행 성공/완료 후. 로그, 후처리, 검증 후보. |
| `PostToolUseFailure` | - | 있음 | X | X | Claude tool 실행 실패 후. |
| `PostToolBatch` | - | 있음 | X | X | Claude 병렬 tool batch 완료 후. |
| `Notification` | - | 있음 | Claude | 알림 구현 + 세션 저장 | Claude가 사용자 입력 또는 주의 필요 상태를 알릴 때 wmux 알림을 보내고, session id/cwd가 있으면 갱신한다. |
| `MessageDisplay` | - | 있음 | X | X | Claude assistant 메시지 표시 중. |
| `SubagentStart` | 있음 | 있음 | X | X | subagent 시작 시점. |
| `SubagentStop` | 있음 | 있음 | X | enum만 | wmux-cli enum에는 있지만 설치하지 않는다. |
| `TaskCreated` | - | 있음 | X | X | Claude task 생성 시점. |
| `TaskCompleted` | - | 있음 | X | X | Claude task 완료 시점. |
| `Stop` | 있음 | 있음 | Codex, Claude | 알림 구현 + 세션 저장 | agent turn 완료 시 wmux 완료 알림을 보내고, session id/cwd가 있으면 갱신한다. |
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
  - 세션 저장 이벤트: `SessionStart`, `UserPromptSubmit`, `Stop`
  - `~/.codex/hooks.json`에 hook을 설치하고, `~/.codex/config.toml`의
    `[features] hooks = true`를 보장한다.

- `ClaudeHookAdapter`
  - 설치 이벤트: `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`,
    `Notification`
  - 알림 이벤트: `Stop`, `PermissionRequest`, `Notification`
  - 세션 저장 이벤트: `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`
  - `~/.claude/settings.json`에 hook을 설치한다.

설치 시 기존 설정 전체를 덮어쓰지 않는다. `wmux-cli hooks <agent> ...` 형태의
wmux 소유 hook만 제거한 뒤 현재 버전의 hook을 다시 추가한다.
기존에 이전 버전의 Claude hook을 설치한 환경은 `SessionStart`,
`UserPromptSubmit` hook이 없을 수 있으므로, agent session restore를 사용하기
전에 `wmux-cli hooks setup claude --yes`를 다시 실행해야 한다.

## 세션 복원 정책

hook command는 `WMUX_SURFACE_ID`, `WMUX_WORKSPACE_ID`, `WMUX_AGENT_SESSION_TOKEN`이
있을 때만 wmux로 세션 binding IPC를 보낸다. backend는 token이 현재 live PTY의
workspace/surface에 발급된 값인지 확인한 뒤에만 renderer event를 emit한다.
복원 대상은 wmux가 agent command로 띄운 로컬 Codex/Claude Code pane과, wmux의
로컬 shell pane 안에서 실행된 Codex/Claude Code 세션이다. SSH/tmux pane은 로컬
session id/cwd로 오인하지 않도록 제외한다.

`WMUX_AGENT_SESSION_TOKEN`은 local shell의 descendant process가 상속하므로,
experimental restore를 켠 local shell pane에서는 그 pane 안에서 실행한 프로세스를
동일 trust boundary로 본다. 이 범위가 부담스러운 경우 agent 전용 pane에서만 사용한다.

`Restore Codex and Claude sessions` experimental 옵션이 켜져 있으면 저장된
session id를 사용해 재시작 시 다음 명령으로 복원한다.

| Agent | 기본 복원 명령 | dangerous 옵션 사용 시 |
|-------|----------------|------------------------|
| Codex | `codex resume <session-id>` | `codex resume --dangerously-bypass-approvals-and-sandbox <session-id>` |
| Claude Code | `claude --resume <session-id>` | `claude --dangerously-skip-permissions --resume <session-id>` |

옵션을 끄면 live workspace와 저장된 session data의 agent binding을 즉시 제거한다.

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
2. 세션 복원이 실패했을 때 fallback 안내와 session id 삭제 UI를 추가할지 검토한다.
3. 공통 이벤트인 `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`,
   `SubagentStop`를 adapter 모델에 추가할지 결정한다.
4. Claude Code의 `Elicitation`을 사용자 입력 요청 알림으로 처리할지 검토한다.
