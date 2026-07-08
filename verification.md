# Verification

## 2026-04-25 Design Follow-up

- `pnpm build`: 통과. `tsc && vite build` 성공.
- Vite 경고: minified chunk 500kB 초과 경고만 남음.
- Chrome headless preview: 일반 브라우저 환경에서 Tauri window API `metadata` 오류로 React root가 비어 실제 UI screenshot 검증은 불가.
- Gradient 제거 후 `pnpm build`: 통과. CSS bundle `8.92 kB`, gzip `2.36 kB`.
- `pnpm tauri build`: 통과. 바탕화면 `wmux.lnk` 대상 `src-tauri/target/release/wmux.exe` 갱신 확인.
- Custom titlebar 후 `pnpm tauri build`: 통과. 바탕화면 `wmux.lnk` 대상 `src-tauri/target/release/wmux.exe` 갱신 확인.

## 2026-04-25 Linux Deb Build on 0.7

- 0.7 `pnpm tauri build --bundles deb`: 통과.
- `.deb`: `/home/seyeongkim/build/wmux-codex/src-tauri/target/release/bundle/deb/wmux_0.1.0_amd64.deb`, 5.2 MB.

## 2026-05-03 AI Pane Hook Leak

- `pnpm build`: 통과.
- 실행 내용: `tsc && vite build`.
- 잔여 경고: Vite chunk size warning만 발생. 이번 변경과 무관한 번들 크기 경고다.
- 0.7 deploy: `/home/seyeongkim/Projects/wmux`를 `e6df8c5`로 fast-forward 후 `pnpm install --frozen-lockfile`, `pnpm tauri build --bundles deb` 통과.
- 설치 패키지: `/home/seyeongkim/Projects/wmux/src-tauri/target/release/bundle/deb/wmux_0.1.0_amd64.deb`.
- 설치 확인: `dpkg -s wmux`가 `Status: install ok installed`, `Version: 0.1.0`, `Architecture: amd64`를 보고했다.
- Windows deploy: 바탕화면 `wmux.lnk` 대상이 `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`임을 확인하고 `pnpm tauri build --no-bundle`로 해당 exe를 갱신했다.
- Windows exe 확인: `LastWriteTime` 2026-05-03 10:22:49, SHA256 `C2F2F1E7A187615546C81E256BE4C3EF2B2521F5D07C777BAF2EDE77D318D1D0`.
- 0.7 install: `apt-get install` 성공, `wmux (0.1.0) over (0.1.0)` 업그레이드 처리.
- `dpkg -s wmux`: `install ok installed`, `Architecture: amd64`, `Version: 0.1.0`.
- Installed binary: `/usr/bin/wmux`, ELF x86-64, `ldd` missing dependency 없음.

## 2026-05-03 Close Confirmation

- `pnpm build`: 통과.
- 실행 내용: `tsc && vite build`.
- 잔여 경고: Vite chunk size warning만 발생. 이번 변경과 무관한 번들 크기 경고다.
- Desktop entry: `/usr/share/applications/wmux.desktop`, `desktop-file-validate` 문제 출력 없음.

## 2026-05-03 Deployment Instructions

- `git diff --check -- AGENTS.md CLAUDE.md research.md plan.md implement.md verification.md feedback.md`: 통과.

## 2026-05-06 Multi-Session Sidebar (Plan A)

- `cargo check` (src-tauri): 통과.
- `cargo test --lib tmux_remote`: 5 passed (parse_basic, parse_passthrough_options, parse_no_target, safe_token_accepts, safe_token_rejects).
- `pnpm tsc --noEmit`: 통과.
- `pnpm build`: 통과 (`tsc && vite build`). Vite chunk size warning만 잔존.
- 변경 파일:
  - 추가: `src-tauri/src/tmux_remote.rs`, `src/stores/tmuxSessions.ts`, `src/components/SidebarTmuxSessions.tsx`, `src/utils/tmuxSession.ts`.
  - 수정: `src-tauri/src/lib.rs` (모듈 등록 + 4 IPC + 기존 두 함수 SSH 파싱 헬퍼화), `src/App.tsx` (attach 호출 + visibility pause/resume + sanitize 적용), `src/stores/workspace.ts` (removeWorkspace 시 detach), `src/components/Sidebar.tsx` (호스트 행 아래 SidebarTmuxSessions 렌더).
- 미수행 (수동 검증 필요):
  - 0.7 호스트 manual smoke test: `tmux new -d -s foo; tmux new -d -s bar` 후 wmux 연결 → 사이드바에 wrapper + foo + bar 표시 / 각 클릭 전환 / kill 시 다음 세션 자동 attach.
  - SSH 프로세스 leak (5s polling) 확인.

## 2026-05-06 Multi-Session Sidebar — Windows Deploy

- Commit: `22d5f3f`, pushed to `origin/master` (xtrusia/wmux).
- Pre-deploy: shortcut target = `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`. No running `wmux.exe`.
- Build: `pnpm tauri build --no-bundle` 통과 (release, 40.54s).
- 갱신 확인: `LastWriteTime` 2026-05-06 11:30:04, SHA256 `C24657AB8DF541920E996D2A530EA1F94D53171C3AFDB4B43CCD8F5C54015EDD`.

## 2026-05-06 Close Confirm Modal — Linux Deploy on 0.7

- Commit: `1698928` (pushed; HEAD == origin/master). 5c5a46c..1698928 fast-forward 적용.
- 0.7 `pnpm install --frozen-lockfile`: lockfile up to date.
- 0.7 `pnpm tauri build --bundles deb`: 통과. `cargo` release 23.22s. Vite chunk size warning만 잔존.
- 패키지: `/home/seyeongkim/Projects/wmux/src-tauri/target/release/bundle/deb/wmux_0.1.0_amd64.deb`, 5,441 kB.
- `apt-get install`: 성공, `wmux (0.1.0) over (0.1.0)` 업그레이드.
- `dpkg -s wmux`: `Status: install ok installed`, `Version: 0.1.0`, `Architecture: amd64`.
- Installed binary: `/usr/bin/wmux`, ELF x86-64 dynamic, BuildID `51d209882d2ee973d22957fec7a0b38611a374e9`.

## 2026-06-12 Clipboard Image Paste — Windows Deploy

- Commit: `ec8c7d3`, pushed to `origin/master` (xtrusia/wmux).
- `pnpm exec tsc --noEmit`: 통과.
- `cargo check` (src-tauri): 통과.
- Smoke test: 백엔드와 동일 형태의 ssh stdin 전송으로 cnode(0.9)에 PNG 업로드 — 원격 SHA256 일치 (`ebf4f635…`), 경로 echo 정상, 테스트 파일 정리 완료.
- Build: `pnpm tauri build --no-bundle` 통과 (release, 37.92s). Vite chunk size warning만 잔존.
- 갱신 확인: `LastWriteTime` 2026-06-12 13:44:44, SHA256 `FC65D4A36801AADD14F815D0A9616D0F9CA52AF3C679BAE24B82710B028882CA`.
- 미수행 (수동 검증 필요): 실제 앱에서 Win+Shift+S 후 SSH pane Ctrl+V — WebView2의 `navigator.clipboard.read()` 권한 자동 허용 여부 확인. 거부 시 텍스트 paste로 폴백.

## 2026-07-05 Top Dashboard Files Rail — Windows Deploy

- Commit: `3494d75` (`feat/osc52-clipboard`). Push to `origin/feat/osc52-clipboard` was blocked by approval policy because it would send code to GitHub.
- `cargo check` (src-tauri): 통과.
- `cargo test` (src-tauri): 통과, 66 passed.
- `pnpm run build`: 통과. Vite chunk size warning만 잔존.
- `pnpm run test:ts`: 140/143 passed. 실패 3개는 기존 Windows path expectation (`cliPackaging`, `terminalPaste`)이며 이번 dashboard/files 변경 범위 밖.
- Build: `pnpm tauri build --no-bundle` 통과. 첫 시도는 Tauri CLI가 `cargo`를 PATH에서 못 찾아 실패했고, `C:\Users\one\.cargo\bin`을 PATH에 추가해 재실행 성공.
- Shortcut fix: `C:\Users\one\Desktop\wmux.lnk` target을 `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`로 갱신.
- 갱신 확인: `LastWriteTime` 2026-07-05 10:06:31, SHA256 `12A1328BEB4377791FFDD4F0D7BFB9F4A183B07C0206CD93B7787E07942989A4`.

## 2026-07-05 Single-Line Top Dashboard — Windows Deploy

- Commit: `f4b53a1` (`feat/osc52-clipboard`).
- `pnpm run build`: 통과. Vite chunk size warning만 잔존.
- `cargo check` (src-tauri): 통과.
- Build: `pnpm tauri build --no-bundle` 통과.
- Shortcut check: desktop `wmux.lnk` and taskbar `wmux.lnk` / `wmux (2).lnk` all target `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`.
- 갱신 확인: `LastWriteTime` 2026-07-05 10:38:28, SHA256 `2CDD2DCA4D2085EAED23FCEEA4819820848777147B71F4D2E7EA1AAB5E2AD682`.

## 2026-07-05 Top Tab Activity Labels — Windows Deploy

- Commit: `5670ba2` (`feat/osc52-clipboard`).
- `node --test tests\workspaceTabTitle.test.ts`: 통과, 5 passed.
- `pnpm run build`: 통과. Vite chunk size warning만 잔존.
- `cargo check` (src-tauri): 통과.
- `pnpm run test:ts`: 145/148 passed. 실패 3개는 기존 Windows path expectation (`cliPackaging`, `terminalPaste`)이며 이번 top-tab 변경 범위 밖.
- Build: `pnpm tauri build --no-bundle` 첫 시도는 Tauri CLI가 `cargo`를 PATH에서 못 찾아 실패했고, `C:\Users\one\.cargo\bin`을 PATH에 추가해 재실행 성공.
- Shortcut check: desktop `wmux.lnk` and taskbar `wmux.lnk` / `wmux (2).lnk` all target `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`.
- 갱신 확인: `LastWriteTime` 2026-07-05 11:05:49, SHA256 `EEC19FECE49F2B97CE158B48D2BAEE07080F74D38ACE5E030D374DA2D72E3641`.

## 2026-07-05 Top Tab Hover Animation — Windows Deploy

- Commit: `0a768e7` (`feat/osc52-clipboard`).
- `pnpm run build`: 통과. Vite chunk size warning만 잔존.
- Build: `pnpm tauri build --no-bundle` 첫 시도는 실행 중인 `wmux.exe` 파일 잠금으로 실패했고, 기존 exe를 같은 release 폴더의 `.bak-20260705111931`로 이동 후 재실행 성공.
- Shortcut check: desktop `wmux.lnk` and taskbar `wmux.lnk` / `wmux (2).lnk` all target `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`.
- 갱신 확인: `LastWriteTime` 2026-07-05 11:20:11, SHA256 `729C6E6641B2A1FB276E457325B60FCF50D3881E034B406E30A1EB616DD6BFAA`.
- Cleanup note: `src-tauri\target\release\wmux.exe.bak-20260705111931` 삭제는 실행 중인 이전 프로세스가 파일을 잡고 있어 권한 거부됨.

## 2026-07-05 Terminal Render Batching — Windows Deploy

- Commit: `66f8f7e` (`feat/osc52-clipboard`).
- 변경 범위: PTY output frame batching, terminal `fit()` coalescing, split drag ratio RAF throttling, divider hover inline mutation 제거.
- `node --test tests\terminalWriteBuffer.test.ts tests\terminalOutput.test.ts`: 통과, 7 passed.
- `pnpm run build`: 통과. Vite chunk size warning만 잔존.
- `cargo check` (src-tauri): 통과.
- `node --test tests/*.test.ts`: 148/151 passed. 실패 3개는 기존 Windows path expectation (`cliPackaging`, `terminalPaste`)이며 이번 render batching 변경 범위 밖.
- Build: `pnpm tauri build --no-bundle` 통과.
- Shortcut check: desktop `wmux.lnk` and taskbar `wmux.lnk` / `wmux (2).lnk` all target `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`.
- 갱신 확인: `LastWriteTime` 2026-07-05 11:40:18, SHA256 `F5598ACA143FE188A503113423718E59667D3C14CF6D951C661708BA631289D9`.

## 2026-07-05 Windows IPC Collision Launch Fix — Windows Deploy

- Symptom: app appeared and immediately closed.
- Cause: stale hidden `wmux.exe` process had `MainWindowHandle = 0` and held the Windows IPC singleton mutex; new app hit `AlreadyRunning` and called `app.exit(0)`.
- Recovery: stopped hidden process PID `60076`; launching `wmux.exe` then produced a responsive process with a real window handle.
- Commit: `bcd2f58` (`feat/osc52-clipboard`).
- `cargo check` (src-tauri): 통과.
- `cargo test platform` (src-tauri): 통과, 16 passed.
- Fix verification: with an existing wmux process present, launching the rebuilt exe stayed open and reported `MainWindowHandle = 48434618`, `Responding = True`.
- Build: `pnpm tauri build --no-bundle` 통과.
- Shortcut check: desktop `wmux.lnk` and taskbar `wmux.lnk` / `wmux (2).lnk` all target `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`.
- 갱신 확인: `LastWriteTime` 2026-07-05 12:35:32, SHA256 `6E203873C670A886F53CFE8FAB598A3AD3C1158B848156FFDFCA0BBE3EF0BAEA`.

## 2026-07-05 SSH Tab Title Local Cwd Fix — Windows Deploy

- Commit: `8bf7bdb` (`feature/ssh-tab-title`) — `Keep SSH tab titles from using stale local cwd`.
- Build: `pnpm tauri build --no-bundle` 통과. 첫 시도는 pnpm registry signature 검증이 sandbox 네트워크 제한으로 실패했고, 승인 실행에서 `C:\Users\one\.cargo\bin`을 PATH에 추가해 재실행 성공.
- Built application: `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`.
- Shortcut refresh: desktop `wmux.lnk` and taskbar `wmux.lnk` / `wmux (2).lnk` 기존 파일을 `.bak-20260705143906`으로 백업 후 재생성.
- Shortcut caveat: Codex tool process runs as `seyeongkim\codexsandboxoffline`, so WScript Shell resolves profile-relative shortcut target as `C:\Users\CodexSandboxOffline\...` during automated verification. The shortcut files were created under `C:\Users\one\Desktop` and `C:\Users\one\AppData\Roaming\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar` for the `one` profile.
- 갱신 확인: `LastWriteTime` 2026-07-05 14:37:40, SHA256 `A6126A5C053E3CB89A7D6517049415793AA6D94948646A9BFBB563A5E091E502`.

## 2026-07-06 Tab Drag-Reorder + Resizable Files Rail

- Branch `feature/tab-reorder-filerail-width` off origin/master (#27 merged). Commit `ce49a00`. PR #28.
- Typecheck: `pnpm exec tsc --noEmit` 통과.
- Tests: `pnpm test:ts` 157/160 통과. 실패 3개(cliPackaging, terminalPaste x2)는 origin/master clean 상태에서도 동일하게 실패하는 사전 존재 문제(빌드된 sidecar / 네이티브 클립보드 의존)로 이번 변경과 무관 — stash 후 재현 확인.
- Added test: `tests/sidebarLayout.test.ts` (clampFilesRailWidth min/max/round) 통과.
- Build: `pnpm build` (tsc && vite build) 통과.

## 2026-07-06 Tokyo Night Storm + Custom Themes

- Branch `feature/custom-themes` off origin/master. Commit `02b8be5`. Merged as PR #29.
- Typecheck `pnpm exec tsc --noEmit` 통과. `pnpm build` 통과.
- Tests: 새 테스트 4개 통과 — Storm built-in 존재/배경 `#24283b`, 커스텀 테마 우선 해석+override, store add(dedupe)/remove(override 정리+active 리셋). 사전 존재 실패 3개(cliPackaging, terminalPaste)는 무관.
- Tokyo Night Storm 팔레트는 mbadolato/iTerm2-Color-Schemes `windowsterminal/TokyoNight Storm.json` 공식값 사용.

## 2026-07-06 Windows Install — Both Features from master

- master `7c035d9` (PR #28 + #29 merged). Build `pnpm tauri build --no-bundle` 통과 (cargo release 52.78s).
- Built: `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`.
- Installed: copied to `C:\Users\one\AppData\Local\wmux\wmux.exe` (Copy verified: built SHA256 == installed SHA256).
- Installed SHA256 `82C2D319706F50AD74F649D0D90DC08F7271AB4945DE210807975ADD5F097B74`, LastWriteTime 2026-07-06 08:54:31. Baseline `0AAF9217...`에서 변경 확인.
- No wmux process was running at install time (guard passed).

## 2026-07-06 Settings Open Lag Fix — Windows Install

- Branch `fix/settings-open-lag` (commit `657e166`), PR #30. Cause: opening Settings always ran `list_fonts` (PowerShell InstalledFontCollection, hundreds of families) and rendered one preview-per-typeface button. Fix: font browse list collapsed by default; `list_fonts` + previews only run on expand; displayFonts memoized + capped at 120.
- Typecheck 통과. `pnpm test:ts` 162/165 통과 (사전 존재 3개 무관). Build `pnpm tauri build --no-bundle` 통과 (cargo release 32.21s).
- Built from committed fix-branch state (= master + fix, PR #30 아직 머지 전이라 동일 내용에서 빌드).
- Installed: `C:\Users\one\AppData\Local\wmux\wmux.exe`, SHA256 `548CCBCD1D35536021F02A72131B5EABC8A60619AB189F478367A5302610EA4E`, LastWriteTime 2026-07-06 09:07:11. 이전 설치본 `82C2D319...`에서 변경 확인. 설치 시 실행 중 wmux 없음.

## 2026-07-06 Long-Run Exit Mitigation — Windows Deploy

- Reported symptom: several wmux panes/windows were left open for about an hour and wmux was gone afterward.
- Local forensic check: no live `wmux.exe`; no recent `Application Error`/`Windows Error Reporting` event for wmux; no `C:\Users\one\AppData\Local\CrashDumps\wmux*.dmp`; WebView2 Crashpad reports empty. ProgramData WER `Critical_wmux.exe` records found were from 2026-03-19, not this incident.
- Changes: enabled release `tauri-plugin-log` file logging to `C:\Users\one\AppData\Local\com.wmux.terminal\logs\wmux.log`; added frontend `error`/`unhandledrejection`, window close, beforeunload, and PTY lifecycle logs; added Rust panic/setup/PTY spawn/exit logs; changed Windows WebGL renderer default to off unless the user explicitly re-enables it in Settings.
- `pnpm run build`: 통과. Vite chunk size warning만 잔존.
- `cargo check` (src-tauri): 통과.
- `cargo test` (src-tauri): 통과, 66 passed. 기존 `pasted_image` test warnings 2개만 잔존.
- Targeted TS tests: `node --test tests/runtimePlatform.test.ts tests/settings.test.ts tests/ptyBackend.test.ts` 통과, 10 passed.
- Full `pnpm run test:ts`: 162/165 passed. 실패 3개는 기존 Windows path expectation (`cliPackaging`, `terminalPaste`)이며 이번 long-run/logging/WebGL 변경 범위 밖.
- Build: `pnpm tauri build --no-bundle` 통과. 첫 시도는 Tauri CLI가 `cargo`를 PATH에서 못 찾아 실패했고, `C:\Users\one\.cargo\bin`을 PATH에 추가해 재실행 성공.
- Built application: `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`, SHA256 `ABC6BD25E8E774BA40BCC252101C889B108F85B5E8D956D8062C36B41432EC61`.
- Installed: copied `wmux.exe` and `wmux-cli.exe` to `C:\Users\one\AppData\Local\wmux\`. Installed `wmux.exe` SHA256 matches build (`ABC6BD25E8E774BA40BCC252101C889B108F85B5E8D956D8062C36B41432EC61`); installed `wmux-cli.exe` SHA256 `9F750EC7D925F5A5387BE9B8EF4F2B5AF2183338CAE0983A50F764655D4C1CB1`.
- Smoke launch: project release exe started with `MainWindowHandle = 4592316`; installed exe started with `MainWindowHandle = 2495350`; log file was created/updated and contained `wmux setup complete`, `frontend boot`, and restored PTY spawn lines. Test processes were stopped afterward; no wmux/child test processes remained.
- 갱신 확인: installed `wmux.exe` `LastWriteTime` 2026-07-06 11:13:35, SHA256 `ABC6BD25E8E774BA40BCC252101C889B108F85B5E8D956D8062C36B41432EC61`.

## 2026-07-06 Silent Exit Follow-up — Windows Deploy

- Follow-up incident: installed diagnostic build disappeared again. `wmux.log` had no `beforeunload`, close-requested, panic, frontend error, or PTY-exit record. Last wmux line before the report was `2026-07-06 12:21:32` (`pty spawned id=12`). No live `wmux.exe`, no `CrashDumps\wmux*.dmp`, no recent WER/Application Error/WebView Crashpad report. System log had Display 4107 events at 12:33:36, 12:35:08, 12:43:03, 12:43:10.
- Changes: Windows WebView2 is launched with `--disable-gpu`; saved WebGL renderer settings are reset once on Windows via `win-disable-webgl-20260706`; Rust setup log now includes PID and emits 60s process heartbeat; frontend logs loaded renderer settings and 60s renderer heartbeat; terminal WebGL load/context-loss paths log explicitly.
- `pnpm run build`: 통과. Vite chunk size warning만 잔존.
- `cargo check` (src-tauri): 통과.
- `cargo test` (src-tauri): 통과, 66 passed. 기존 `pasted_image` test warnings 2개만 잔존.
- Targeted TS tests: `node --test tests\runtimePlatform.test.ts tests\settings.test.ts tests\ptyBackend.test.ts` 통과, 11 passed.
- Full `pnpm run test:ts`: 165/168 passed. 실패 3개는 기존 Windows path expectation (`cliPackaging`, `terminalPaste`)이며 이번 silent-exit follow-up 변경 범위 밖.
- Build: `pnpm tauri build --no-bundle` 통과. Built application: `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`.
- Installed: copied `wmux.exe` and `wmux-cli.exe` to `C:\Users\one\AppData\Local\wmux\`. Installed `wmux.exe` SHA256 `5A97E1B4FDCD7065002C185D21B635AA2889E1FD69964E4B0E48070BD960223A`; installed `wmux-cli.exe` SHA256 `9F750EC7D925F5A5387BE9B8EF4F2B5AF2183338CAE0983A50F764655D4C1CB1`.
- Smoke launch: installed exe started as PID `49108`. Log confirmed `webview2 disable-gpu configured=true` and `frontend settings platform=windows webgl=false webglUserSet=false`. Rust/frontend heartbeats were recorded at 13:06 and 13:07. The later exit logged `window close confirmed` at 13:08:37, so that shutdown went through the expected close path.

## 2026-07-08 Silent Exit Reproduction — Renderer OOM from PTY Output Event Flood

- Setup: isolated dev instance (`com.wmux.terminal.isolated.itestc0ffee`, temp local edits only: env gate to skip `--disable-gpu`, WebGL default forced on), 9–13 panes each running an AI-TUI-like stream script (colored token bursts + spinner line rewrites, ~25–60ms cadence). Panes driven over CDP (`--remote-debugging-port`), memory sampled to CSV every 60s.
- GPU-reset hypothesis rejected: with GPU on + WebGL on under full streaming load, both a graphics driver restart (Win+Ctrl+Shift+B equivalent) and a DPMS monitor off/wake cycle were survived. No `terminal webgl context lost` was even logged; rendering stayed live (frame-diff verified).
- Reproduced crash: after 4h00m of streaming (14:23–18:24) the WebView2 renderer crashed with error page "오류 코드: Out of Memory". Crashpad dump `EBWebView\Crashpad\reports\1f54cae7-....dmp` at 18:24:07; last frontend heartbeat 18:23:11. Rust host process stayed alive with heartbeats (differs from the original incidents where the whole process vanished — possibly release/system-memory-pressure variant of the same failure).
- Attribution: renderer process private memory grew ~100–170MB/min under load while JS heap stayed flat (~50–63MB) — native memory, not JS objects. GPU process stayed ~150MB. WebGL off (DOM renderer) made no difference: still ~105MB/min growth. Stopping the stream processes dropped renderer memory 1.9GB → 1.3GB within one minute and growth stopped completely.
- Conclusion: `pty-output` is emitted per small read chunk as a broadcast Tauri event (hundreds of events/sec across panes, every pane's listener receives every event and filters by id). Under sustained AI-TUI-style output the renderer-side native delivery queue outgrows consumption until OOM. Unrelated to GPU/WebGL; `--disable-gpu` does not address it.
- Fix direction (not yet implemented): coalesce PTY reads in Rust before emitting (per-pty flush every ~16ms or N KB), and/or move pty-output to per-pty `tauri::ipc::Channel` instead of broadcast events.
- Temp edits reverted; working tree clean. Test artifacts (stream/driver scripts, soak CSVs, heap CSV) in session scratchpad only.
- Note: the 8ms coalescing emitter from #9 was present during the OOM run. It merges bursts but a spinner-style trickle still produces one event per chunk, so coalescing alone does not cap the event rate.

## 2026-07-08 PTY Event Channel Fix

- Change: `pty-output`/`pty-exit` now flow over a single `tauri::ipc::Channel` that the frontend registers via the new `subscribe_pty_events` command, replacing broadcast `app.emit`. Frontend keeps the same `PtyBackend.onOutput/onExit` interface (channel fan-out happens in `tauriPtyBackend`); App.tsx's pane auto-close listener moved onto the same path. WebView2 `--disable-gpu` flag removed — the GPU-reset hypothesis was rejected by the reproduction above and the flag costs compositing performance without addressing the OOM. Windows WebGL renderer default stays off.
- `cargo check` (src-tauri): 통과.
- `cargo test` (src-tauri): 통과, 66 passed. (`pnpm run build`와 병렬 실행한 첫 시도는 tauri-winres 빌드 스크립트 충돌로 실패, 단독 재실행 통과.)
- `pnpm run build`: 통과. 기존 chunk size warning만 잔존.
- `pnpm run test:ts`: 165/168. 실패 3개는 기존 Windows path expectation (`cliPackaging`, `terminalPaste`) — 변경 범위 밖.
- Load verification (isolated instance, 12 streaming panes, GPU on): renderer private memory 292→435MB in the first minute (scrollback fill), then flat at ~440–480MB for 5 minutes. Same load on the event path grew 1,296→1,927MB in 6 minutes (~105MB/min, unbounded). Channel-delivered output verified rendering via CDP screenshot.
