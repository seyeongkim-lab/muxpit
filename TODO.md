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
- [ ] Phase 8: 설정 + 세션 복원
