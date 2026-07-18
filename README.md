# muxpit

A Windows-first terminal multiplexer built for working with AI coding agents
over SSH. Tauri + React + xterm.js desktop app with tmux-style workspaces,
split panes, and prefix-key navigation.

## Features

- **Workspaces & split panes** — tmux-like sessions in a sidebar: split, zoom,
  cycle layouts, resize, and break a pane into its own workspace.
- **Prefix-key navigation** — configurable tmux-style prefix (default
  `Ctrl+Shift+B`) plus direct `Ctrl+Shift+*` shortcuts.
- **Grid overview** — `Ctrl+Shift+G` shows every workspace as a live miniature
  terminal; click a cell to jump to it.
- **SSH hosts & remote tmux** — save hosts and connect in one click; on tmux
  3.2+ sessions run under `tmux -CC` so they mirror into the sidebar and survive
  disconnects.
- **AI CLI integration** — probes remote and local hosts for Claude, Codex,
  Gemini, Copilot, and OpenCode, auto-splits them, and reports working/waiting/
  done/error states to an inbox via hooks.
- **Remote monitor** — sidebar charts for CPU, memory, and network (uPlot), plus
  listing and resuming Claude sessions on the connected host.
- **Pane control CLI** — `muxpit-cli` can identify, list, split, focus, send
  text to, and read panes; spawn subagent panes; and script browser panes
  (navigate, snapshot, console capture). SSH panes use an authenticated loopback
  relay.
- **Sessions & profiles** — resume detected sessions in place; save and recreate
  terminal/browser layouts as launch profiles.
- **Quality of life** — clipboard-image paste into SSH panes, scrollback, auto
  save/restore, custom themes, and Korean/Hangul font fallback.

## Tech stack

| Layer    | Tech |
|----------|------|
| Shell    | [Tauri 2](https://tauri.app/) (Rust) |
| Frontend | React 19, TypeScript, Vite, [zustand](https://github.com/pmndrs/zustand) |
| Terminal | [xterm.js](https://xtermjs.org/) |
| Charts   | [uPlot](https://github.com/leeoniya/uPlot) |
| PTY      | [portable-pty](https://crates.io/crates/portable-pty) |

- `src/` — React frontend (components, zustand stores, hooks, themes)
- `src-tauri/` — Rust backend: PTY, tmux control-mode, SSH monitor, IPC server
- `muxpit-cli/` — standalone CLI that talks to the app over IPC

The app and `muxpit-cli` communicate over a local IPC channel (named pipe
`\\.\pipe\muxpit` on Windows, `/tmp/muxpit.sock` on Unix). The CLI is stateless;
the frontend mirrors the workspace list to the backend so `muxpit-cli ls` works.

## Getting started

Prerequisites: [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/), the
[Rust toolchain](https://rustup.rs/), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install     # install JS deps
pnpm tauri dev   # run in dev mode
pnpm tauri build # release bundle (--no-bundle for just the executable)
```

## Companion CLI

Build it with `pnpm build:cli` (set `MUXPIT_CLI_TARGET` to a Rust target triple
for cross-target packaging). With the app running:

```bash
muxpit-cli ping
muxpit-cli ls
muxpit-cli notify "Build done" "All tests passed"
muxpit-cli split --direction horizontal --command codex
muxpit-cli send-text --enter "npm test"
muxpit-cli read-screen --rows 40
muxpit-cli hooks setup --yes
muxpit-cli browser open https://example.com
```

Pane control requires the `MUXPIT_CONTROL_TOKEN` injected into muxpit terminals;
SSH panes reach the same allowlisted API through a per-pane loopback relay that
never binds to a public interface. `hooks setup --yes` installs muxpit-owned hook
entries for supported CLIs without touching unrelated user hooks, and does
nothing outside a muxpit pane — run it on remote hosts too for SSH-relayed inbox
events.

Release bundles ship the CLI: `/usr/bin/muxpit-cli` (Linux deb/rpm, or inside
the AppImage), next to `muxpit.exe` (Windows), or in `Contents/MacOS` on macOS
(Settings can symlink `~/.local/bin/muxpit-cli`).

## Keyboard shortcuts

Direct shortcuts:

| Shortcut        | Action                  |
|-----------------|-------------------------|
| `Ctrl+Shift+T`  | New workspace           |
| `Ctrl+Shift+X`  | Close workspace         |
| `Ctrl+Shift+D`  | Split horizontal        |
| `Ctrl+Shift+E`  | Split vertical          |
| `Ctrl+Shift+W`  | Close focused pane      |
| `Ctrl+Shift+G`  | Toggle grid overview    |
| `Ctrl+Shift+O`  | Open browser pane       |
| `Ctrl+Shift+I`  | Toggle notifications    |
| `Ctrl+,`        | Settings                |
| `Ctrl+=/-/0`    | Font size up/down/reset |

Prefix mode (press the prefix key first; default `Ctrl+Shift+B`, configurable in
Settings):

| Key            | Action                          |
|----------------|---------------------------------|
| `"` / `%`      | Split vertical / horizontal     |
| arrows         | Move focus (`Ctrl`+arrows: resize) |
| `o`            | Cycle focus to next pane        |
| `z`            | Toggle zoom                     |
| `x`            | Close pane                      |
| `Space`        | Cycle layout                    |
| `!`            | Break pane into a new workspace |
| `c`            | New workspace                   |
| `n` / `p`      | Next / previous workspace       |
| `0`–`9`        | Select workspace by index       |
| `q`            | Show pane numbers (then a digit picks one) |
| `h`            | Open history panel              |

## Clipboard

Select with the mouse and press `Ctrl+C` to copy. In a remote tmux pane with
mouse mode on, hold `Shift` while dragging to force a local selection.

muxpit honors OSC 52 clipboard writes (reads are ignored, so a remote can't read
your clipboard) and auto-configures `set-clipboard on` for the tmux session it
manages — no edits to your remote `~/.tmux.conf` needed. For tmux sessions you
start yourself, enable it manually:

```tmux
set -g set-clipboard on
set -ga terminal-features ',*:clipboard'
# tmux < 3.2, replace the line above with:
# set -ga terminal-overrides ',*:Ms=\E]52;%p1%s;%p2%s\007'
```

## License

MIT — see [LICENSE](LICENSE).
