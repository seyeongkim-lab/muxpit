# wmux TODO

> 점검 2026-06-17: 완료/대체된 항목은 정리. 아래는 미구현만 남김.

## Pending Features
- [ ] 원격 cwd 복구: SSH 재접속 시 마지막 cwd로 `cd` 전송 (프롬프트 타이밍 의존)
  - cwd 추적 인프라(OSC 7 + `get_process_cwd`)는 있으나 세션 복원 시 복구 적용은 미구현
- [ ] 로컬 cwd 복구: 세션 복원 시 추적된 cwd로 셸 재시작

## Phase 10: 원격 세션 지속성 — 남은 작업
tmux control mode 통합(Step 1)과 `persistMode` 토글은 구현 완료. 남은 항목:
- [ ] pane 매핑 정책: wmux pane = tmux window vs window 내 split (현재 single window만)
- [ ] 패인 헤더 상태 뱃지 (tmux / plain / reconnecting)
- [ ] tmux 미설치 감지 시 명시적 toast 안내
- [ ] (옵션, 낮은 우선순위) wmux-server 프로토콜 (A 경로) — tmux-CC(B 경로)로 핵심 요구 충족됨
