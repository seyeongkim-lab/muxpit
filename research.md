# wmux Research

## cmux 분석 (macOS 원본)

### 핵심 기능
1. **사이드바 (Vertical Tabs)**: git branch, PR 상태, 작업 디렉토리, 리스닝 포트, 알림 배지
2. **Split Panes**: 수직/수평 분할, 비활성 패인 투명도
3. **Workspace**: 독립된 작업 공간, 각각 여러 Surface(탭) 포함
4. **알림 시스템**: OSC 시퀀스, CLI, 배지, 데스크톱 알림
5. **내장 브라우저**: WebKit 기반, 스크립터블 API
6. **CLI**: `cmux` 명령어로 모든 기능 제어 (소켓 IPC)
7. **Claude Code 통합**: Hook으로 알림 연동, 환경변수로 컨텍스트 전달

### UI 계층
Window > Workspace > Pane > Surface > Panel (Terminal | Browser)

### CLI 주요 명령
- workspace: list/new/select/close
- surface: list/focus/new-split
- send/send-key: 터미널 입력 전송
- notify/set-status/set-progress: 사이드바 메타데이터
- browser: navigate/snapshot/click/fill/evaluate

### 설정
- Ghostty config 호환 (font, theme, colors)
- 자동화 모드 (off/cmuxOnly/allowAll)
- 알림 커스텀 명령어

---

## 기술 스택 조사

### Tauri v2 (Windows)
- 최신 안정판: v2.6+
- WebView2 (Chromium 기반) - Windows 10 1803+ / 11에 기본 포함
- 번들 크기 ~10MB, 메모리 효율적
- Rust 백엔드 + WebView 프론트엔드

### xterm.js
- 최신: v5.5.0
- WebGL2 렌더러 지원 (GPU 가속)
- 필수 애드온: fit, webgl, web-links, search, unicode11
- WebView2에서 문제 없이 동작

### PTY on Windows
- ConPTY (Windows 10 1809+)
- **portable-pty** (WezTerm 프로젝트): 가장 성숙, 크로스 플랫폼
- **tauri-plugin-pty**: Tauri v2 플러그인, PTY 통합 간소화

### 기존 프로젝트 참고
- **Terminon**: Tauri v2 + React + xterm.js + portable-pty (분할패인, SSH, WSL)
- **tauri-terminal**: 최소 구현 참고용
- **tauri-plugin-pty**: 재사용 가능한 플러그인
