# Feedback

## 2026-07-05 Top Dashboard Files Rail

- Manual smoke test needed: Settings -> Dashboard -> `Top tabs + files` 전환 후 상단 `Sessions`, `Hosts`, `Monitor` popover 동작 확인.
- Manual smoke test needed: 로컬 터미널에서 `cd` 이동 시 왼쪽 `FILES` rail이 cwd를 따라가는지 확인.
- Manual smoke test needed: SSH/tmux workspace에서 `FILES` rail이 원격 cwd를 listing하는지 확인.
- Known gap: file rail은 현재 browse-only다. 다운로드/열기 동작은 이번 테스트 설치 범위에서 제외했다.

## 2026-07-05 Single-Line Top Dashboard

- Manual smoke test needed: `Top tabs + files` 모드에서 titlebar와 dashboard가 한 줄로만 보이는지 확인.
- Manual smoke test needed: 왼쪽 session tab을 클릭해 workspace 전환, `+`로 새 workspace 생성, tab `x`로 닫기 확인.
- Manual smoke test needed: 상단 빈 영역 drag, double-click maximize, 우측 window controls 동작 확인.

## 2026-07-05 Top Tab Activity Labels

- Manual smoke test needed: 터미널에서 `printf '\033]0;nvim package.json\007'` 같은 OSC title을 보낸 뒤 상단 session tab 제목이 바뀌는지 확인.
- Manual smoke test needed: Codex/Claude/SSH/tmux workspace에서 tab 제목이 `codex: cwd`, `ssh target`, `tmux: session` 형태로 표시되는지 확인.
- Manual smoke test needed: SSH monitor가 켜진 상태에서 Monitor 숫자가 갱신되어도 session tab 전환/hover가 끊기지 않는지 확인.

## 2026-07-05 Top Tab Hover Animation

- Manual smoke test needed: 상단 workspace tab과 Hosts/Monitor tab에 마우스를 올릴 때 scale/transition 없이 즉시 반응하는지 확인.

## 2026-07-05 Terminal Render Batching

- Manual smoke test needed: `yes | head -n 5000` 또는 큰 `git diff` 출력 시 UI가 덜 끊기는지 확인.
- Manual smoke test needed: split divider를 빠르게 드래그할 때 terminal resize가 따라오되 cursor/레이아웃이 과하게 떨리지 않는지 확인.
- Manual smoke test needed: 여러 pane이 있는 상태에서 workspace tab 전환, font size 변경, 창 resize 후 terminal fit이 정상인지 확인.

## 2026-07-05 Windows IPC Collision Launch Fix

- Manual smoke test needed: 작업표시줄 아이콘으로 wmux를 다시 실행했을 때 창이 바로 닫히지 않는지 확인.
- Manual smoke test needed: 기존 wmux 창이 이미 떠 있는 상태에서 한 번 더 실행했을 때 새 창이 유지되는지 확인.
