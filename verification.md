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
