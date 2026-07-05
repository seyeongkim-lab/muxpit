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
