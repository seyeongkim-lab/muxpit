# Agent workbench v0.1

## Goal

wmux에서 로컬과 SSH 원격 AI 세션을 같은 방식으로 제어하고, attention이 필요한 pane을 한곳에서 찾고, 반복 작업 공간을 다시 열 수 있게 한다.

## Scope

### SSH control relay

- wmux는 loopback TCP control relay를 임의의 로컬 포트에 연다.
- SSH pane마다 고유한 remote loopback port를 reverse-forward한다.
- 원격 command에는 workspace ID, surface ID, control token, relay address를 전달한다.
- 원격 helper는 기존 `identify`, `list-surfaces`, `split`, `focus`, `send-text`, `read-screen` 계약을 사용한다.
- relay는 control allowlist만 받으며 기존 workspace, surface, token 검증을 그대로 거친다.
- reverse forward를 만들지 못해도 일반 SSH 접속은 유지하고 pane에 명확한 경고를 출력한다.

### Agent task inbox

- pane별 상태는 `working`, `waiting`, `done`, `error` 중 하나다.
- hook notification의 workspace ID와 surface ID로 상태를 갱신한다.
- inbox는 attention이 필요한 `waiting`, `done`, `error`를 최근 순서로 보여준다.
- 항목을 선택하면 해당 workspace와 surface로 이동하고 읽음 처리한다.

### Session resume adapters

- Codex는 `codex resume <session-id>`를 사용한다.
- Claude는 `claude --resume <session-id>`를 사용한다.
- Gemini는 `gemini --resume <session-id>`를 사용한다.
- Copilot은 `copilot --resume <session-id>`를 사용한다.
- OpenCode는 `opencode --session <session-id>`를 사용한다.
- 저장된 base command에서 prompt, 비대화형 subcommand, 권한 우회 옵션을 제거한다.

### Project launch profiles

- profile은 이름과 pane tree를 저장한다.
- terminal leaf는 command와 CWD를 저장하고 browser leaf는 URL을 저장한다.
- 현재 workspace를 profile로 저장할 수 있다.
- profile 실행은 새 workspace를 만들고 저장된 pane tree를 복원한다.
- profile은 사용자 로컬 저장소에만 저장하며 repository 파일을 자동 실행하지 않는다.

### Native subagent panes

- control CLI로 parent pane 옆에 subagent terminal pane을 만들 수 있다.
- subagent pane은 parent surface ID와 label을 metadata로 가진다.
- inbox에서 subagent pane을 일반 AI pane과 같은 방식으로 추적하고 이동할 수 있다.

### Scriptable browser pane

- browser surface는 iframe 대신 Tauri child webview를 사용해 일반 원격 페이지를 표시한다.
- control CLI는 URL 이동, 현재 URL 조회, page text snapshot, console/error 조회를 제공한다.
- script 실행은 고정된 읽기 전용 동작으로 제한한다. 임의 JavaScript 평가는 제공하지 않는다.
- screenshot은 지원 플랫폼에서 PNG 파일을 반환하며 미지원 플랫폼은 명확한 오류를 반환한다.

## Security boundaries

- relay listener는 `127.0.0.1`에만 bind한다.
- SSH remote forward도 remote loopback에만 bind한다.
- 모든 relay control request는 pane별 128-bit token과 origin workspace, surface를 검증한다.
- token은 frontend event payload, control response, 로그에 포함하지 않는다.
- browser automation은 target browser surface와 고정 action allowlist를 검증한다.
- launch profile은 사용자가 직접 저장한 값만 실행한다.

## Verification

- parser와 pure state transition은 TypeScript 또는 Rust unit test로 고정한다.
- relay는 loopback socket integration test에서 authorized request와 invalid token을 확인한다.
- SSH argv test는 reverse forward가 target 앞에 있고 remote environment가 shell-quoted 되었는지 확인한다.
- session resume adapter는 다섯 CLI의 command 생성과 위험 옵션 제거를 확인한다.
- profile round trip과 inbox jump target을 TypeScript test로 확인한다.
- browser command allowlist와 surface validation을 unit test로 확인한다.
- repository canonical TypeScript test, Rust test, build를 모두 통과한다.
