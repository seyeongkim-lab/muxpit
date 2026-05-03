# Feedback

## 2026-04-25 Design Follow-up

- Refactoring UI 기준 현재 점수: 8.5/10.
- 좋아진 점: accent/background/text가 sidebar와 sidebar card chrome에 더 일관되게 연결되고, 산발적인 gradient/glow가 제거되어 더 차분해짐.
- 좋아진 점: Windows native header를 앱 theme 변수 기반 custom chrome으로 대체해 상단까지 색이 이어짐.
- 남은 리스크: 실제 Tauri WebView에서 window drag/double-click maximize/button hover는 수동 확인이 필요하다.

## 2026-04-25 Linux Deb Build on 0.7

- 0.7에 `.deb` 빌드 및 설치 완료.
- GUI launch는 SSH 세션에서 display/session 연결이 불확실해 실행하지 않고 패키지/파일/동적 의존성 기준으로 검증했다.
## 2026-05-03 AI Pane Hook Leak

- 커밋: `e6df8c5 Fix AI pane hook leak`.
- 푸시: `origin/master`에 반영.
- 배포: 0.7 Linux host에서 `.deb` 빌드 및 `apt-get install` 완료.
- Windows 배포: 바탕화면 `wmux.lnk`가 가리키는 release exe 갱신 완료.
- 남은 확인: 실제 GUI에서 codex/gemini pane을 열어 hook 문자열이 입력되지 않는지 수동 smoke test.

## 2026-05-03 Close Confirmation

- 구현: 창 닫기 요청 시 확인창을 먼저 띄우고, 승인한 경우만 세션 저장 후 종료한다.
- 검증: `pnpm build` 통과.
- 남은 확인: 실제 GUI에서 닫기 버튼과 커스텀 close 버튼 모두 확인창을 띄우는지 수동 smoke test.

## 2026-05-03 Deployment Instructions

- `AGENTS.md`에 Linux 0.7 `.deb` 배포와 Windows desktop shortcut exe 갱신 절차를 고정했다.
- `CLAUDE.md`는 `@AGENTS.md` import만 둔다.
