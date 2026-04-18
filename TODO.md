# wmux TODO

## Known Issues
- [ ] `Ctrl+1~9` 워크스페이스 전환 단축키 안 됨 (xterm.js 키 이벤트 가로채기 문제)
  - `attachCustomKeyEventHandler` + capture phase 모두 시도했으나 동작 안 함
  - 대안: Alt+1~9로 변경하거나, xterm.js textarea에 직접 이벤트 핸들러 부착 필요

## Pending Features
- [ ] `Ctrl++` / `Ctrl+-` 전체 애플리케이션 폰트 크기 조절
- [ ] SSH 자동 재접속: 분할 시 기존 PTY 자식 프로세스에서 ssh.exe 명령줄 추출 → 새 패인에 자동 실행
- [ ] 원격 cwd 복구: SSH 접속 후 cd 전송 (프롬프트 타이밍 의존)
- [ ] 로컬 cwd 복구: 프로세스 cwd 추적

## Remaining Phases
- [ ] Phase 6: CLI (`wmux` 명령어로 외부 제어) - Named Pipe IPC
- [ ] Phase 7: 내장 브라우저
- [ ] Phase 8: 설정 + 세션 복원 (레이아웃-only, 전 플랫폼)
- [ ] Phase 10: 원격 세션 지속성 (하이브리드) — [plan.md §Phase 10](plan.md)
  - [ ] Step 1: tmux control mode 통합 (B 경로, 원격 무설치) — **최우선**
    - [ ] `check_remote_tmux` 함수 (tmux -V 3.2+ 감지)
    - [ ] SSH 명령 자동 래핑 (`tmux -CC new -A -s wmux-{hostname}`)
    - [ ] `src-tauri/src/tmux_cc.rs` — control mode 파서
    - [ ] pane 매핑 정책 결정 (wmux pane = tmux window vs window 내 split)
    - [ ] 재접속 지수 백오프 (1s→2s→5s→10s→30s)
  - [ ] Step 2: fallback + UI 상태 뱃지 + SSH 프로파일별 토글
  - [ ] Step 3: wmux-server 프로토콜 (A 경로, 옵션) — 스파이크 재활용
    - [ ] Unix socket → SSH stdio 전송 레이어 교체
    - [ ] Hello/버전 협상 PDU
    - [ ] 원격 사이드바 확장 (git/ports/proc)
  - [ ] Step 4: wmux-server 배포 + 내장 설치 UX
- [x] ~~로컬 Unix 데몬 모드~~ (폐기: 원격 지속성이 진짜 요구사항)
