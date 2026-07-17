# muxpit

A Windows-first terminal multiplexer built for working with AI coding agents over SSH.

muxpit is a desktop app (Tauri + React + xterm.js) that gives you tmux-style
workspaces, split panes, and prefix-key navigation on Windows — plus first-class
support for driving remote sessions through `tmux -CC` (control mode) and for
auto-launching AI CLIs (Claude Code, Codex, Gemini, Copilot, OpenCode) when you connect to
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
- **AI CLI auto-split** — on SSH connect, wmux probes the remote for Claude Code, Codex, Gemini, Copilot, and OpenCode. It can start Claude automatically, and the per-pane toolbar can launch any detected CLI from the source pane's current directory.
- **Remote session monitor** — a sidebar panel shows remote system stats (CPU,
  memory, network throughput via uPlot charts) and lists/resumes Claude Code
  sessions on the connected host.
- **Agent inbox** — hooks for Claude Code, Codex, Gemini, Copilot, and OpenCode report working, waiting, done, and error states. Selecting an item returns to its workspace and pane.
- **Local AI launcher** — open Claude, Codex, Gemini, Copilot, or OpenCode beside the focused local terminal and inherit its current directory.
- **Pane control CLI** — local and SSH processes can identify, list, split, focus, send text to, and read visible text from terminal panes. SSH panes use an authenticated loopback reverse-forward relay.
- **Session resume and launch profiles** — detected sessions can be resumed in place, while user-local profiles save and recreate terminal and browser layouts with their commands, URLs, and working directories.
- **Native subagent panes** — `wmux-cli subagent spawn` opens a child process next to its parent pane and tracks it in the inbox.
- **Scriptable browser panes** — native child webviews support navigation, current URL, read-only page snapshots, console/error capture, and macOS screenshots through the control CLI. Arbitrary JavaScript execution is not exposed.
- **Quality-of-life** — clipboard-image paste into SSH panes, scrollback/history, session auto-save and restore, customizable themes, and Korean/Hangul font fallback.

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
│   └── src/main.rs            # notifications, hooks, workspace and pane control
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
wmux-cli identify
wmux-cli split --direction horizontal --command codex
wmux-cli subagent spawn --command "codex exec 'run tests'" --label tests
wmux-cli hooks setup --yes
wmux-cli browser open https://example.com
wmux-cli browser navigate https://example.com
wmux-cli browser snapshot
wmux-cli send-text --enter "npm test"
wmux-cli read-screen --rows 40
```

Pane control commands require the `WMUX_CONTROL_TOKEN` injected into muxpit terminal processes. SSH panes receive a remote helper and connect to the same allowlisted control API through a per-pane loopback reverse forward. The relay does not bind to a public interface.

`wmux-cli hooks setup --yes` installs muxpit-owned hook entries for supported CLIs without replacing unrelated user hooks. Installed hooks do nothing outside a muxpit pane. Run the setup command on a remote host too when its agent lifecycle events should use the SSH relay and appear in the inbox.

Release bundles include the companion CLI:

- Linux `.deb`/`.rpm`: `/usr/bin/wmux-cli`
- Linux AppImage: bundled inside the AppImage under `usr/bin/wmux-cli`
- Windows installer: `wmux-cli.exe` next to `muxpit.exe` in the install directory
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
| `Ctrl+Shift+O`  | Open browser pane       |
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

muxpit receives OSC 52 clipboard writes from the terminal, and for the remote tmux
session it manages it sets `set-clipboard on` and the matching terminal feature
automatically on connect — so a tmux copy (mouse drag or copy-mode) reaches the
local clipboard without editing your remote `~/.tmux.conf`. Only writes are
honored; OSC 52 read requests are ignored so a remote cannot read your clipboard.

This auto-config applies to the muxpit-managed session. For a tmux session you
start yourself (or a nested tmux), enable it in the remote `~/.tmux.conf`:

```tmux
set -g set-clipboard on
set -ga terminal-features ',*:clipboard'
```

On tmux older than 3.2, replace the second line with:

```tmux
set -ga terminal-overrides ',*:Ms=\E]52;%p1%s;%p2%s\007'
```

## License

MIT — see `src-tauri/Cargo.toml`.
