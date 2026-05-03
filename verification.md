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
- 0.7 install: `apt-get install` 성공, `wmux (0.1.0) over (0.1.0)` 업그레이드 처리.
- `dpkg -s wmux`: `install ok installed`, `Architecture: amd64`, `Version: 0.1.0`.
- Installed binary: `/usr/bin/wmux`, ELF x86-64, `ldd` missing dependency 없음.
- Desktop entry: `/usr/share/applications/wmux.desktop`, `desktop-file-validate` 문제 출력 없음.
