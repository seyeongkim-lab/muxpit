# wmux

A Windows-first terminal multiplexer built for working with AI coding agents over SSH.

wmux is a desktop app (Tauri + React + xterm.js) that gives you tmux-style
workspaces, split panes, and prefix-key navigation on Windows — plus first-class
support for driving remote sessions through `tmux -CC` (control mode) and for
auto-launching AI CLIs (Claude Code, Codex, Gemini, Copilot) when you connect to
a host.

## Features

- **Workspaces & split panes** — tmux-like sessions in a sidebar; split
  horizontally/vertically, zoom a pane, cycle layouts, resize, and break a pane
  into its own workspace.
- **Prefix-key navigation** — configurable tmux-style prefix (default
  `Ctrl+Shift+B`) for splits, focus movement, pane numbers, layout cycling, and
  workspace switching, plus direct `Ctrl+Shift+*` shortcuts.
- **Grid overview** — `Ctrl+Shift+G` shows every workspace at once as live
  miniature terminals; click a cell to jump to it.
- **SSH host management** — save hosts (user, port, identity file) and connect
  with one click.
- **Remote tmux control mode** — when a remote host has tmux 3.2+, sessions are
  wrapped in `tmux -CC` so windows/sessions are mirrored into the sidebar and
  survive disconnects (`persistMode`).
- **AI CLI auto-split** — on SSH connect, wmux probes the remote for installed AI
  CLIs and, when `claude` is present, auto-splits a pane running it. The per-pane
  toolbar can launch the other detected CLIs.
- **Remote session monitor** — a sidebar panel shows remote system stats (CPU,
  memory, network throughput via uPlot charts) and lists/resumes Claude Code
  sessions on the connected host.
- **Notifications** — in-app panel plus native OS toasts; can be triggered from
  scripts via the `wmux-cli` companion CLI (e.g. `wmux-cli notify "Build done"`).
- **Quality-of-life** — embedded browser pane, clipboard-image paste into SSH
  panes, scrollback/history panel, session auto-save & restore, customizable
  themes and fonts (with Korean/Hangul font fallback).

## Tech stack

| Layer    | Tech |
|----------|------|
| Shell    | [Tauri 2](https://tauri.app/) (Rust) |
| Frontend | React 19, TypeScript, Vite, [zustand](https://github.com/pmndrs/zustand) |
| Terminal | [xterm.js](https://xtermjs.org/) (WebGL renderer, fit & web-links addons) |
| Charts   | [uPlot](https://github.com/leeoniya/uPlot) |
| PTY      | [portable-pty](https://crates.io/crates/portable-pty) |

## Project structure

```
.
├── index.html                 # Vite entry
├── src/                       # React frontend
│   ├── App.tsx                # Top-level shell: layout, keybindings, session wiring
│   ├── main.tsx
│   ├── components/            # UI: terminal, split pane, sidebar, panels, dialogs
│   │   ├── Terminal.tsx           # xterm.js instance wrapper
│   │   ├── SplitPane.tsx          # recursive layout-tree renderer
│   │   ├── GridOverview.tsx       # all-workspaces grid view
│   │   ├── Sidebar*.tsx           # sidebar: hosts, tmux sessions, monitor, Claude
│   │   ├── MonitorPane.tsx        # remote system stats charts
│   │   ├── BrowserPane.tsx        # embedded webview pane
│   │   └── ...                    # toolbars, overlays, settings, SSH host editor
│   ├── stores/                # zustand state
│   │   ├── workspace.ts           # layout tree (leaf/split), save & restore
│   │   ├── sshHosts.ts            # saved hosts + ssh command builder
│   │   ├── aiCli.ts               # AI CLI probe & availability per host
│   │   ├── tmuxSessions.ts        # tmux control-mode attach per workspace
│   │   ├── monitor.ts             # remote monitor data
│   │   ├── settings.ts            # theme, font size, prefix key
│   │   └── ...                    # notifications, prefix, history, sidebarLayout
│   ├── hooks/                 # useWorkspaceInfo (git/ports/ssh-context pollers)
│   ├── utils/                 # layout geometry, prefix-key & tmux-name helpers
│   ├── themes.ts              # theme definitions + CSS-var resolution
│   └── styles/
├── src-tauri/                 # Rust backend (Tauri app)
│   └── src/
│       ├── lib.rs                 # Tauri command surface + app setup
│       ├── main.rs
│       ├── pty.rs                 # PTY spawn/IO; tmux-CC spawning
│       ├── tmux_cc.rs             # tmux control-mode protocol parser
│       ├── tmux_remote.rs         # SSH argument parsing for remote tmux
│       ├── monitor.rs             # remote system monitoring over SSH
│       ├── sysinfo.rs             # local workspace info (git, ports, shell ctx)
│       └── ipc.rs                 # named-pipe / unix-socket server for the CLI
├── wmux-cli/                  # standalone CLI that talks to the app over IPC
│   └── src/main.rs            # `wmux-cli ping | notify | ls`
└── docs/                      # design plans
```

The app and the `wmux-cli` companion CLI communicate over a local IPC channel (named pipe
`\\.\pipe\wmux` on Windows, `/tmp/wmux.sock` on Unix). The CLI is stateless; the
frontend mirrors the workspace list to the backend so `wmux-cli ls` can read it.

## Getting started

Prerequisites: [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/), the
[Rust toolchain](https://rustup.rs/), and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install        # install JS deps
pnpm tauri dev      # run the app in dev mode
```

Build a release binary / installer:

```bash
pnpm tauri build              # platform default bundles
pnpm tauri build --no-bundle  # just the executable
pnpm tauri build --bundles deb  # Linux .deb
pnpm tauri build --bundles rpm  # Linux .rpm
pnpm tauri build --bundles appimage  # Linux AppImage
```

Build the companion CLI:

```bash
pnpm build:cli
WMUX_CLI_TARGET=x86_64-pc-windows-msvc pnpm build:cli
# then, with the app running:
wmux-cli ping
wmux-cli notify "Build done" "All tests passed"
wmux-cli ls
```

Release bundles include the companion CLI:

- Linux `.deb`/`.rpm`: `/usr/bin/wmux-cli`
- Linux AppImage: bundled inside the AppImage under `usr/bin/wmux-cli`
- Windows installer: `wmux-cli.exe` next to `wmux.exe` in the install directory
- macOS `.app`: `Contents/MacOS/wmux-cli`; Settings can install
  `~/.local/bin/wmux-cli` as a symlink for terminal use

For cross-target packaging, set `WMUX_CLI_TARGET` to the Tauri/Rust target triple
before `pnpm tauri build` so the sidecar CLI is prepared for the same target.

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
| `Ctrl+Shift+B`  | Open browser pane       |
| `Ctrl+Shift+I`  | Toggle notifications    |
| `Ctrl+,`        | Settings                |
| `Ctrl+=/-/0`    | Font size up/down/reset |

Prefix mode (press the prefix key first; default `Ctrl+Shift+B`):

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

> Note: the prefix key is configurable in Settings.

## Clipboard

Selecting text with the mouse and pressing `Ctrl+C` copies to the system
clipboard. In a remote pane running tmux with mouse mode on, the drag is
captured by tmux instead of the local terminal, so hold `Shift` while dragging
to force a local selection.

To make a plain mouse-drag copy reach the system clipboard, let the remote tmux
forward the selection over OSC 52. wmux honors OSC 52 clipboard writes; enable it
on the remote in `~/.tmux.conf`:

```tmux
set -g set-clipboard on
set -ga terminal-features ',*:clipboard'
```

On tmux older than 3.2, replace the second line with:

```tmux
set -ga terminal-overrides ',*:Ms=\E]52;%p1%s;%p2%s\007'
```

Reload with `tmux kill-server` (or restart the session). wmux only accepts
clipboard writes; OSC 52 read requests are ignored so a remote cannot read your
clipboard.

## License

MIT — see `src-tauri/Cargo.toml`.
