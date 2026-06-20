# How to Recover a wmux Session

이 문서는 wmux가 앱 재시작 후 workspace, terminal pane, SSH/tmux 연결, Claude session을 어떤 범위까지 복원하는지 정리한다. 또한 `cmux`의 `HOW_TO_RECOVER_SESSION.md` 모델과 비교해 현재 wmux에 있는 것과 아직 없는 것을 구분한다.

## 핵심 모델

wmux의 복원은 크게 세 경로로 나뉜다.

1. **앱 workspace snapshot**
   - `src/stores/workspace.ts`의 `saveSession()` / `restoreSession()`이 담당한다.
   - workspace 목록, active workspace, split layout, focused leaf, browser URL, SSH command, structured SSH connection, tmux session 이름, AI pane metadata 일부를 저장한다.
   - 저장된 PTY process를 되살리는 방식이 아니라, 저장된 layout DTO를 읽고 새 terminal surface와 새 PTY를 만든다.

2. **remote tmux 지속성**
   - SSH host가 `tmux -CC` persist mode로 열렸다면 leaf에 `tmuxSession`이 저장된다.
   - 앱 재시작 후 같은 SSH command와 tmux wrapper session으로 다시 attach한다.
   - 실제 shell/process 지속성은 wmux가 아니라 remote tmux server가 제공한다.

3. **remote Claude session 목록과 수동 resume**
   - monitor가 연결된 SSH host에서 `$HOME/.claude/projects`를 스캔해 Claude session 목록을 만든다.
   - 목록에서 resume하면 `cd <projectPath> && claude --resume <sessionId>` 형태의 SSH command를 새 workspace로 실행한다.
   - 이 목록은 앱 snapshot에 저장되는 세션 인덱스가 아니라, remote monitor가 다시 스캔해서 만드는 runtime 정보다.

cmux와 비교하면, cmux는 **Sessions 목록**과 **앱 재시작 snapshot**을 명확히 분리하고, agent transcript/history 저장소를 별도로 인덱싱한다. wmux는 아직 그런 전역 agent session index가 없고, workspace snapshot과 remote monitor/tmux 기능이 각자 복구 역할을 나누어 갖는 구조다.

## Snapshot 저장 위치

wmux는 현재 Tauri/WebView의 `localStorage`에 session snapshot을 저장한다.

```text
wmux-session
wmux-session:<platform>
```

- `wmux-session`: 기본/legacy session key.
- `wmux-session:<platform>`: 예를 들어 `wmux-session:linux`, `wmux-session:windows`, `wmux-session:macos`.
- snapshot에는 `schemaVersion`과 `sourcePlatform`이 들어간다.
- 다른 OS에서 저장한 snapshot을 현재 OS에서 열면, command/SSH/tmux처럼 플랫폼에 묶인 필드는 복원하지 않을 수 있다. 이 경우 이후 저장은 플랫폼별 key로 분리된다.

cmux는 macOS Application Support 아래에 JSON 파일을 저장한다.

```text
~/Library/Application Support/cmux/session-<bundle-id>.json
~/Library/Application Support/cmux/session-<bundle-id>-previous.json
```

cmux는 atomic write, unchanged write skip, primary snapshot 손상 시 `-previous` fallback을 갖는다. wmux는 아직 primary/previous 백업이나 atomic repository 계층이 없고, `localStorage.setItem()` 실패나 JSON parse 실패는 조용히 무시하거나 복원 실패로 처리한다.

## 저장되는 정보

wmux의 workspace snapshot에 저장되는 대표 정보:

- workspace
  - `id`
  - `name`
  - `nameSource`
  - `focusedLeafId`
  - split layout tree
- app state
  - `activeId`
  - `sourcePlatform`
  - `schemaVersion`
- terminal leaf
  - `command`
  - `sshCommand`
  - `sshConnection`
  - `sshRemoteCommand`
  - `tmuxSession`
  - `aiKind`
  - `aiSshTarget`
  - `lastCwd` (experimental `Restore local session CWD`가 켜진 local pane만)
- browser pane
  - `url`
- legacy monitor/Claude session node
  - monitor node는 현재 복원 시 plain terminal leaf로 변환된다.
  - Claude session node는 가능한 경우 `claude --resume <sessionId>` SSH command leaf로 변환된다.

저장되지 않는 대표 정보:

- `ptyId`
- live PTY process
- local shell에서 실행 중이던 임의 process
- terminal scrollback snapshot
- terminal input draft
- live cwd snapshot (기본값 off. experimental `Restore local session CWD`가 켜진 local pane만 `lastCwd` 저장)
- `zoomedLeafId`
- `layoutMode`
- tmux session sidebar의 runtime list 자체
- remote monitor snapshot 자체
- Claude/Codex 등 agent transcript index

cmux는 window, workspace, panel, focus, 일부 scrollback, cwd, agent resume 정보까지 snapshot에 포함한다. 따라서 cmux는 마지막 앱 화면을 더 넓은 범위로 재구성할 수 있고, wmux는 현재 terminal/workspace 구조와 재실행 가능한 command/tmux attachment를 중심으로 복원한다.

## 언제 저장되는가

wmux는 다음 시점에 session snapshot을 저장한다.

- workspace 목록이나 active workspace가 바뀐 뒤 500ms debounce.
- `beforeunload` 이벤트.
- wmux 자체 close confirmation에서 사용자가 종료를 확정했을 때.

앱 시작 시에는 `restoreSession()`을 먼저 시도하고, 실패하거나 저장된 workspace가 없으면 `Shell 1` workspace를 만든다. 복원에 성공하면 SSH/tmux leaf를 찾아 tmux session poller를 다시 attach하고, restored SSH workspace에 대해 AI CLI auto-split도 다시 평가한다.

cmux는 기본 8초 autosave timer, quit 직전, system power-off/session resign active, update relaunch 준비, startup restore 직후 저장을 갖는다. wmux에는 아직 주기적 autosave/fingerprint skip/typing-aware save 같은 계층은 없다.

## 재시작하면 실제로 벌어지는 일

wmux 재시작 후 흐름:

1. React app이 mount된다.
2. `restoreSession()`이 `localStorage`에서 현재 platform key 또는 legacy key를 읽는다.
3. JSON parse와 최소 구조 확인에 성공하면 workspace/layout DTO를 새 Zustand 상태로 만든다.
4. leaf의 `ptyId`는 항상 `null`로 복원된다.
5. terminal component가 mount되면 저장된 leaf command를 기반으로 새 PTY를 spawn한다.
6. leaf에 `tmuxSession`이 있으면 `spawn_pty_tmux_cc` 경로로 remote tmux session에 attach한다.
7. restore 후 SSH/tmux leaf가 있으면 sidebar tmux session poller를 다시 시작한다.
8. 저장된 session이 없거나 복원에 실패하면 새 기본 shell workspace를 만든다.

이 과정은 기존 PTY 객체를 되살리는 것이 아니다. snapshot에서 새 object graph와 새 PTY를 만드는 방식이다.

## cwd 저장과 복원

wmux는 runtime cwd를 일부 추적한다.

- terminal output의 OSC 7 `file://...` escape를 파싱해 workspace info store에 cwd를 반영한다.
- local process metadata polling에서도 cwd를 얻어 sidebar 표시와 workspace 자동 이름에 활용한다.
- live pane split 시 source PTY의 shell context에서 cwd를 읽어 새 pane에 `cd "<cwd>"`를 입력할 수 있다.
- remote Claude session 목록은 Claude transcript의 `cwd` 필드를 읽어 resume용 `projectPath`로 사용한다.

기본값에서는 wmux session snapshot에 일반 terminal cwd를 저장하지 않는다. Settings의 Experimental 섹션에서 `Restore local session CWD`를 켜면 local terminal leaf에 한해 `lastCwd`를 저장하고, 앱 재시작 후 새 local PTY를 그 cwd에서 시작한다. SSH/tmux pane은 이 기능의 대상이 아니며, 저장된 cwd가 삭제됐거나 directory가 아니면 기본 cwd로 shell을 연다.

Windows에서는 이 옵션이 켜진 local default shell에만 cwd reporting hook을 넣는다. PowerShell은 session-local `prompt` override로 OSC 7 cwd를 보내고, `cmd.exe` fallback은 `prompt` 명령으로 OSC 7을 보낸다. 옵션이 꺼져 있으면 cwd 저장, cwd 복원, Windows cwd reporting hook을 모두 사용하지 않는다.

cmux는 cwd를 snapshot에 여러 레벨로 저장한다.

- workspace current directory
- panel directory
- terminal working directory
- restorable agent working directory

그리고 복원 시 approved surface binding cwd, terminal cwd, agent cwd, panel cwd, workspace cwd 순으로 우선순위를 적용한다. wmux가 cmux 수준의 재시작 복구를 얻으려면 cwd snapshot과 restore priority를 별도 모델로 추가해야 한다.

## Terminal 복원의 한계

wmux에서 복원 가능한 정보:

- workspace 목록과 active workspace
- split layout과 focused leaf
- browser pane URL
- SSH command와 structured SSH connection
- remote tmux wrapper session 이름
- AI pane metadata
- Claude session node의 resume command 변환

복원되지 않는 정보:

- local PTY process 자체
- 일반 shell에서 실행 중이던 process
- terminal scrollback
- terminal input draft
- local shell cwd (experimental `Restore local session CWD`가 꺼져 있거나 cwd를 아직 기록하지 못한 경우)
- process runtime state
- remote monitor의 마지막 수집 결과
- agent process running/idle 상태

따라서 일반 local shell에서 긴 명령이 돌고 있었다면 앱 재시작 후 그 process는 이어지지 않는다. 이 동작은 정상이다. 지속성이 필요하면 remote tmux persist mode를 사용하는 것이 현재 wmux에서 가장 안전한 경로다.

## SSH/tmux session 복구

SSH host 설정의 persist mode가 `auto` 또는 `on`이고 remote host에 지원되는 tmux가 있으면, wmux는 SSH terminal을 `tmux -CC` wrapper session으로 연다.

- `auto`: 접속 전 remote `tmux -V`를 확인하고 지원되면 tmux persist를 사용한다.
- `on`: tmux wrapping을 강제한다.
- `off`: 일반 SSH terminal로 연다.

tmux persist가 켜진 pane은 leaf snapshot에 `tmuxSession`을 저장한다. 앱 재시작 후 wmux는 같은 SSH connection과 wrapper session으로 다시 attach한다. 연결이 끊기면 terminal surface는 backoff를 두고 reconnect를 시도한다.

주의할 점:

- wmux가 local process를 보존하는 것이 아니라 remote tmux가 shell/process를 보존한다.
- SSH 인증이 실패하거나 host가 바뀌거나 tmux server가 죽으면 attach할 수 없다.
- tmux sidebar 목록은 snapshot에 저장되지 않고, attach 후 remote `tmux list-sessions`를 polling해 다시 만든다.
- pane을 닫아도 workspace의 attach context를 잠시 유지해 sidebar에서 tmux session을 다시 열 수 있게 한다.

cmux도 tmux/remote persistent PTY/surface binding을 복원 경로로 사용하지만, agent resume과 cwd priority가 함께 snapshot에 들어간다. wmux는 tmux 쪽은 비교적 강하지만, 그 밖의 local process/agent resume은 아직 가볍다.

## Claude session 복구

wmux의 Claude session 복구는 remote monitor 기반이다.

1. SSH monitor가 remote host에 연결된다.
2. remote `$HOME/.claude/projects` 아래 JSONL transcript를 스캔한다.
3. session id, message count, timestamp, cwd/project path를 파싱한다.
4. 사용자가 sidebar에서 resume하면 새 workspace에 SSH command를 만들고 `claude --resume <sessionId>`를 실행한다.

저장된 legacy `claudeSession` layout node가 있으면 restore 시 plain SSH terminal leaf로 변환하고, 가능한 경우 `cd <projectPath> && claude --resume <sessionId>`를 실행한다.

현재 제한:

- Claude session 목록은 앱 snapshot에 저장되지 않는다.
- monitor가 연결된 remote host 기준으로만 보인다.
- Codex/Gemini/Copilot의 transcript index나 resume index는 아직 없다.
- agent hook store나 live process scan fallback은 없다.
- agent가 저장 당시 running이었는지 idle이었는지 판단해 자동 resume하는 정책도 없다.

cmux는 `~/.cmuxterm/<agent>-hook-sessions.json`과 process detection fallback을 합쳐 restorable agent session을 만들고, Claude/Codex별 cwd 정책과 resume argv/env 보존 정책을 적용한다. wmux에서 같은 수준을 얻으려면 workspace snapshot과 별도의 agent session index가 필요하다.

## Sessions 목록과 command history

wmux의 sidebar workspace list는 현재 app state에서 만들어진다. 이것은 cmux의 agent transcript 기반 Sessions 목록과 다르다.

wmux에는 `wmux-history` localStorage key에 shell command history가 저장된다. 이 history는 shell integration에서 받은 command 목록이며, agent conversation/session index가 아니다.

cmux의 Sessions 목록은 Claude/Codex/Grok/OpenCode/Rovo/Hermes/custom agent 저장소를 다시 스캔하는 별도 runtime index다. 앱 startup snapshot이 실패해도 agent transcript/history가 남아 있으면 Sessions 목록에서 수동 복구할 수 있다. wmux에는 아직 이 독립 복구 경로가 없다.

## 복원이 안 될 때 확인할 것

1. 앱 snapshot 자체가 남아 있는지 확인한다.
   - WebView localStorage의 `wmux-session` 또는 `wmux-session:<platform>` key가 대상이다.
   - key가 없으면 wmux는 기본 `Shell 1` workspace를 만든다.

2. 다른 OS에서 가져온 snapshot인지 확인한다.
   - snapshot의 `sourcePlatform`과 현재 platform이 다르면 command/SSH/tmux 같은 플랫폼 의존 필드는 복원되지 않을 수 있다.
   - 이 경우 layout만 남고 terminal command가 기본 shell로 바뀌는 것이 의도된 동작일 수 있다.

3. tmux pane이 이어지지 않으면 remote tmux 상태를 확인한다.
   - SSH 인증이 되는지 확인한다.
   - remote host에서 `tmux -V`가 3.2 이상인지 확인한다.
   - remote host에서 `tmux list-sessions`에 wrapper session이 남아 있는지 확인한다.
   - host 설정의 persist mode가 `off`가 아닌지 확인한다.

4. 일반 local process가 사라졌다면 정상일 수 있다.
   - wmux는 앱 재시작 후 local PTY/process를 attach하지 않는다.
   - 저장된 command가 있으면 새 PTY에서 다시 실행하고, 없으면 새 shell을 연다.

5. cwd가 달라졌다면 experimental 옵션 상태를 확인한다.
   - Settings > Experimental > `Restore local session CWD`가 꺼져 있으면 cwd를 저장하거나 복원하지 않는다.
   - 이 기능은 local pane만 대상으로 한다. SSH/tmux pane은 remote tmux나 agent resume 경로를 사용한다.
   - 저장된 cwd가 삭제됐거나 directory가 아니면 wmux는 spawn 실패를 피하기 위해 기본 cwd로 shell을 연다.

6. Claude session 목록이 비어 있으면 remote monitor 경로를 확인한다.
   - SSH monitor가 해당 host에 연결되어 있어야 한다.
   - remote `$HOME/.claude/projects`에 JSONL transcript가 있어야 한다.
   - remote shell에서 `sed`, `head`, `tail`, `wc` 같은 기본 POSIX 도구가 PATH에 있어야 한다.

7. Claude resume이 다른 directory에서 열리면 transcript cwd를 확인한다.
   - wmux는 Claude JSONL의 `cwd` 필드를 우선 사용하고, 없으면 Claude project directory 이름에서 path를 추정한다.

8. workspace는 보이지만 tmux sidebar가 비어 있으면 polling/attach를 확인한다.
   - tmux sidebar list 자체는 저장되지 않고 remote polling 결과로 다시 채워진다.
   - 네트워크 지연이나 SSH 실패가 있으면 빈 목록이나 error 상태가 먼저 보일 수 있다.

## 현재 wmux와 cmux의 차이 요약

| 항목 | wmux 현재 동작 | cmux 문서 기준 |
| --- | --- | --- |
| 저장소 | WebView `localStorage` | Application Support JSON |
| 백업/fallback | 없음 | primary + previous |
| atomic write | 없음 | 있음 |
| workspace/layout 복원 | 있음 | 있음 |
| multi-window 복원 | 없음 | 있음 |
| PTY process 보존 | 없음 | 없음 |
| 새 terminal 재구성 | 있음 | 있음 |
| scrollback 복원 | 없음 | 일부 있음 |
| cwd snapshot | experimental local leaf `lastCwd` | 여러 레벨로 있음 |
| tmux persist | 있음, 강한 편 | 있음 |
| agent session index | 없음 | 있음 |
| Claude resume | remote monitor/manual 중심 | hook/process/transcript 기반 |
| Codex resume index | 없음 | SQLite/JSONL 기반 있음 |
| 자동 agent resume | 없음 | 조건부 있음 |
| 수동 transcript recovery | 제한적, Claude remote monitor 중심 | agent별 Sessions 목록 |

## 개선 후보

cmux 문서를 기준으로 wmux에서 우선순위가 높은 개선은 다음 순서다.

1. **복구 문서 유지**
   - 현재 문서를 기능 변경 때마다 업데이트한다.
   - 사용자에게 복원되는 것과 복원되지 않는 것을 명확히 노출한다.

2. **cwd snapshot 확장**
   - 현재는 experimental local leaf `lastCwd`만 저장한다.
   - 향후 workspace/panel 수준 cwd priority와 agent별 cwd 정책까지 확장할 수 있다.

3. **snapshot repository 강화**
   - `localStorage`에 계속 저장하더라도 primary/previous key를 둘 수 있다.
   - 더 나은 방향은 Tauri app data directory에 JSON repository를 두고 atomic write와 schema validation을 추가하는 것이다.

4. **agent session index 분리**
   - app workspace snapshot과 별도로 Claude/Codex transcript/history를 스캔하는 index를 만든다.
   - 앱 snapshot이 깨져도 agent transcript에서 수동 resume할 수 있어야 한다.

5. **agent hook/process fallback**
   - `wmux-cli hooks`를 notification뿐 아니라 restorable session record에도 사용할 수 있다.
   - session id, cwd, transcript path, pid, launch argv/env, lifecycle을 기록하면 automatic/manual resume 품질이 올라간다.

6. **복구 테스트 보강**
   - `saveSession()` / `restoreSession()` round trip.
   - platform mismatch 시 command stripping.
   - tmux leaf restore 후 attach 대상 생성.
   - Claude session node migration.
   - cwd snapshot priority가 확장되면 priority별 restore test.

## 한 줄 요약

wmux의 현재 복구는 `localStorage` workspace snapshot으로 화면 구조와 재실행 가능한 command를 복원하고, 실제 지속성은 remote `tmux -CC`에 크게 의존한다. local cwd 복원은 experimental 옵션으로 제공되며 SSH/tmux pane은 제외된다. cmux는 이보다 넓은 app snapshot, cwd policy, agent session index, hook/process fallback을 갖고 있으므로, wmux가 같은 수준에 가까워지려면 cwd priority 확장과 독립 agent session index를 다음 단계로 추가하는 것이 핵심이다.
