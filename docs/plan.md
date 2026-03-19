# Plan: SSH 호스트 등록 시스템 + 모니터링 글씨 크기 개선

상세 계획서: `docs/plans/ssh-host-management.md`

## 요약

SSH 호스트를 사이드바에서 등록/관리하고, 클릭 한 번으로 접속 + 자동 모니터링을 시작하는 기능.
추가로 사이드바 모니터링 위젯의 글씨 크기를 개선.

## 핵심 설계 결정

1. **백엔드 변경 없음** - 기존 `spawn_pty(command)`, `start_monitor`, `get_shell_ctx` 재사용
2. **프론트엔드만 변경** - 새 스토어 1개, 새 컴포넌트 1개, 기존 파일 4개 수정
3. **모니터링 자동 시작** - 기존 SSH 자동감지 로직이 `leaf.command`를 읽어 자동 처리

## Phase 요약

| Phase | 내용 | 리스크 | 새 파일 | 수정 파일 |
|-------|------|--------|---------|-----------|
| 1 | SSH 호스트 스토어 | Low | `stores/sshHosts.ts` | - |
| 2 | 호스트 관리 UI | Low | `components/SshHostPanel.tsx` | - |
| 3 | 사이드바 통합 + 접속 | Medium | - | `Sidebar.tsx`, `workspace.ts`, `App.tsx` |
| 4 | 모니터링 글씨 크기 | Low | - | `SidebarMonitor.tsx` |
