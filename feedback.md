# Feedback

## 2026-04-25 Design Follow-up

- Refactoring UI 기준 현재 점수: 8.5/10.
- 좋아진 점: accent/background/text가 sidebar와 sidebar card chrome에 더 일관되게 연결되고, 산발적인 gradient/glow가 제거되어 더 차분해짐.
- 좋아진 점: Windows native header를 앱 theme 변수 기반 custom chrome으로 대체해 상단까지 색이 이어짐.
- 남은 리스크: 실제 Tauri WebView에서 window drag/double-click maximize/button hover는 수동 확인이 필요하다.

## 2026-04-25 Linux Deb Build on 0.7

- 0.7에 `.deb` 빌드 및 설치 완료.
- GUI launch는 SSH 세션에서 display/session 연결이 불확실해 실행하지 않고 패키지/파일/동적 의존성 기준으로 검증했다.
