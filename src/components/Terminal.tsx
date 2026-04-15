import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { useWorkspaceStore } from "../stores/workspace";
import { useSettingsStore } from "../stores/settings";
import { usePrefixStore } from "../stores/prefix";
import { useHistoryStore } from "../stores/history";
import { matchesPrefixKey } from "../utils/prefixKey";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { useNotificationStore } from "../stores/notifications";
import { getResolvedTheme } from "../themes";
import "@xterm/xterm/css/xterm.css";

interface PtyOutput {
  id: number;
  data: string;
}

interface PtyExit {
  id: number;
  code: number | null;
}

// Shell history capture hook: injects a bash PROMPT_COMMAND + zsh preexec hook into the spawned
// shell (local or SSH remote) so it emits OSC 777;cmd;<command> before every interactive command.
// wmux parses those sequences and stores them in the shared history store.
// The trailing `&& clear` hides the visual footprint of the injection.
const SHELL_HISTORY_HOOK =
  '{ if [ -n "$BASH_VERSION" ]; then ' +
  '__wmux_emit() { local c=$(fc -ln -1 2>/dev/null); c="${c# }"; c="${c#\t}"; ' +
  '[ -z "$c" ] && return; [ "$c" = "$__wmux_prev" ] && return; ' +
  'case "$c" in *__wmux_emit*|*__wmux_preexec*) return;; esac; ' +
  'printf \'\\033]777;cmd;%s\\a\' "$c"; __wmux_prev="$c"; }; ' +
  'PROMPT_COMMAND="__wmux_emit;${PROMPT_COMMAND:-}"; ' +
  'elif [ -n "$ZSH_VERSION" ]; then ' +
  'autoload -Uz add-zsh-hook; ' +
  '__wmux_preexec() { case "$1" in *__wmux_emit*|*__wmux_preexec*) return;; esac; ' +
  'printf \'\\033]777;cmd;%s\\a\' "$1"; }; ' +
  'add-zsh-hook preexec __wmux_preexec; ' +
  'fi; } 2>/dev/null && clear\r';

// OSC sequence parser: extracts OSC 7 (cwd) and OSC 777 (custom) from terminal output
const parseOscSequences = (data: string, workspaceId: string, leafId: string) => {
  const patchInfo = useWorkspaceInfoStore.getState().patchInfo;

  // OSC 7: current working directory
  // Format: \e]7;file://hostname/path\a  or \e]7;file://hostname/path\e\\
  const osc7Re = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  let m;
  while ((m = osc7Re.exec(data)) !== null) {
    const cwd = decodeURIComponent(m[1]);
    if (cwd) patchInfo(workspaceId, { cwd });
  }

  // OSC 777: custom notifications and metadata
  // Format: \e]777;notify;Title;Body\a
  const osc777NotifyRe = /\x1b\]777;notify;([^;]*);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((m = osc777NotifyRe.exec(data)) !== null) {
    const title = m[1];
    const body = m[2];
    useNotificationStore.getState().addNotification(workspaceId, title, body);
    invoke("send_notification", { title, body }).catch(() => {});
  }

  // OSC 777: git branch info
  // Format: \e]777;git;branchname\a
  const osc777GitRe = /\x1b\]777;git;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((m = osc777GitRe.exec(data)) !== null) {
    const branch = m[1].trim();
    patchInfo(workspaceId, { gitBranch: branch || null });
  }

  // OSC 777: shell command history (emitted by wmux-injected hook in bash/zsh)
  // Format: \e]777;cmd;<command text>\a
  const osc777CmdRe = /\x1b\]777;cmd;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((m = osc777CmdRe.exec(data)) !== null) {
    const cmd = m[1];
    if (cmd) useHistoryStore.getState().addEntry(workspaceId, leafId, cmd);
  }
};

// Global map: keeps terminal instances alive across React re-renders
const terminalInstances = new Map<
  string,
  {
    term: XTerm;
    fitAddon: FitAddon;
    ptyId: number;
    cleanup: {
      unlistenOutput: () => void;
      unlistenExit: () => void;
      onData: { dispose: () => void };
      onResize: { dispose: () => void };
    };
  }
>();

export const destroyTerminal = (leafId: string) => {
  const instance = terminalInstances.get(leafId);
  if (!instance) return;
  invoke("kill_pty", { id: instance.ptyId }).catch(() => {});
  instance.cleanup.unlistenOutput();
  instance.cleanup.unlistenExit();
  instance.cleanup.onData.dispose();
  instance.cleanup.onResize.dispose();
  instance.term.dispose();
  terminalInstances.delete(leafId);
};

export const destroyAllTerminals = (leafIds: string[]) => {
  leafIds.forEach(destroyTerminal);
};

// Apply theme changes to all existing terminals in real-time
useSettingsStore.subscribe((state, prev) => {
  if (state.themeName !== prev.themeName || state.customColors !== prev.customColors) {
    const theme = getResolvedTheme(state.themeName, state.customColors);
    terminalInstances.forEach(({ term }) => {
      term.options.theme = theme;
    });
  }
});

interface TerminalLeafProps {
  workspaceId: string;
  leafId: string;
}

const findSshCommand = (wsId: string, leafId: string): string | undefined => {
  const state = useWorkspaceStore.getState();
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return undefined;
  const find = (node: any): string | undefined => {
    if (node.type === "leaf" && node.id === leafId) return node.command ?? node.sshCommand;
    if (node.type === "split") return find(node.children[0]) ?? find(node.children[1]);
    return undefined;
  };
  return find(ws.layout);
};

const findCloneFromPtyId = (wsId: string, leafId: string): number | undefined => {
  const state = useWorkspaceStore.getState();
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return undefined;
  const find = (node: any): number | undefined => {
    if (node.type === "leaf" && node.id === leafId) return node.cloneFromPtyId;
    if (node.type === "split") return find(node.children[0]) ?? find(node.children[1]);
    return undefined;
  };
  return find(ws.layout);
};

export const TerminalLeaf = ({ workspaceId, leafId }: TerminalLeafProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const setPtyId = useWorkspaceStore((s) => s.setPtyId);
  const setFocusedLeaf = useWorkspaceStore((s) => s.setFocusedLeaf);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const focusedLeafId = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.focusedLeafId,
  );

  const initTerminal = useCallback(async () => {

    if (!containerRef.current || initializedRef.current) return;

    // Re-attach existing terminal DOM to new container
    const existing = terminalInstances.get(leafId);
    if (existing) {
      initializedRef.current = true;
      const xtermEl = existing.term.element;
      if (xtermEl) {
        containerRef.current.appendChild(xtermEl);
        requestAnimationFrame(() => {
          existing.fitAddon.fit();
          existing.term.focus();
        });
      }
      return;
    }

    initializedRef.current = true;

    const settings = useSettingsStore.getState();
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      theme: getResolvedTheme(settings.themeName, settings.customColors),
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon((e, uri) => {
      if (e.ctrlKey) open(uri).catch(() => {});
    }));

    // Clipboard & shortcut handling
    term.attachCustomKeyEventHandler((e) => {
      // Let Ctrl+Shift combos bubble to App shortcuts
      if (e.ctrlKey && e.shiftKey) return false;

      // Let Win/Meta key combos pass through to OS (e.g. Win+V clipboard history)
      if (e.metaKey) return false;

      if (e.type !== "keydown") return true;

      // Prefix mode active or history panel open → swallow all keys
      const prefSt = usePrefixStore.getState();
      if (prefSt.active || prefSt.historyOpen) return false;

      // Pressing the configured prefix key → swallow (App handler will activate prefix mode)
      const prefixKey = useSettingsStore.getState().prefixKey;
      if (matchesPrefixKey(e, prefixKey)) return false;

      // Ctrl+C: copy selection if text is selected, otherwise send interrupt
      if (e.ctrlKey && e.key === "c") {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
          term.clearSelection();
          return false;
        }
        return true; // no selection → send ^C to PTY
      }

      // Ctrl+V: always paste from clipboard
      if (e.ctrlKey && e.key === "v") {
        e.preventDefault();
        navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }

      return true;
    });

    term.open(containerRef.current);

    // Enable WebGL renderer for GPU acceleration
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available, use default DOM renderer
    }

    fitAddon.fit();

    // Set up event listeners BEFORE spawning PTY to avoid missing output
    let ptyId = 0;

    const unlistenOutput = await listen<PtyOutput>("pty-output", (event) => {
      if (event.payload.id === ptyId) {
        const data = event.payload.data;
        term.write(data);
        // Only parse OSC sequences if ESC is present
        if (data.includes("\x1b]")) parseOscSequences(data, workspaceId, leafId);
      }
    });

    const unlistenExit = await listen<PtyExit>("pty-exit", (event) => {
      if (event.payload.id === ptyId) {
        term.write("\r\n\x1b[31m[Process exited]\x1b[0m\r\n");
      }
    });

    const onData = term.onData((data) => {
      invoke("write_pty", { id: ptyId, data }).catch(console.error);
    });

    const onResize = term.onResize(({ rows, cols }) => {
      invoke("resize_pty", { id: ptyId, rows, cols }).catch(console.error);
    });

    // Determine command to run: explicit leaf command first (split inheritance / session restore),
    // then fall back to cloning parent PTY's SSH context.
    let spawnCommand: string | null = null;

    const cloneFromPtyId = findCloneFromPtyId(workspaceId, leafId);
    const savedCmd = findSshCommand(workspaceId, leafId);
    if (savedCmd) {
      spawnCommand = savedCmd;
    } else if (cloneFromPtyId) {
      try {
        const ctx = await invoke<{ ssh_command: string | null; cwd: string | null }>(
          "get_shell_ctx",
          { id: cloneFromPtyId },
        );
        if (ctx.ssh_command) {
          spawnCommand = ctx.ssh_command;
        }
      } catch {
        // Silently ignore context fetch errors
      }
    }

    // Spawn PTY — with command for SSH direct execution, or null for default shell
    ptyId = await invoke<number>("spawn_pty", {
      rows: Math.max(term.rows, 1),
      cols: Math.max(term.cols, 1),
      command: spawnCommand,
    });

    terminalInstances.set(leafId, {
      term,
      fitAddon,
      ptyId,
      cleanup: { unlistenOutput, unlistenExit, onData, onResize },
    });

    // Trigger state update LAST, after everything is set up
    setPtyId(workspaceId, leafId, ptyId);

    // For non-SSH clones, replicate local cwd
    if (cloneFromPtyId && !spawnCommand) {
      try {
        const ctx = await invoke<{ ssh_command: string | null; cwd: string | null }>(
          "get_shell_ctx",
          { id: cloneFromPtyId },
        );
        if (ctx.cwd) {
          setTimeout(() => {
            invoke("write_pty", {
              id: ptyId,
              data: `cd "${ctx.cwd}"\r`,
            }).catch(() => {});
          }, 500);
        }
      } catch {
        // Silently ignore
      }
    }

    // Inject shell history hook (bash + zsh). Skip panes running claude directly.
    const isClaudePane = !!(spawnCommand && spawnCommand.toLowerCase().includes("claude"));
    if (!isClaudePane) {
      setTimeout(() => {
        invoke("write_pty", { id: ptyId, data: SHELL_HISTORY_HOOK }).catch(() => {});
      }, 700);
    }

    term.focus();
  }, [workspaceId, leafId, setPtyId]);

  useEffect(() => {
    initTerminal();
  }, [initTerminal]);

  // Apply font settings changes to existing terminals
  useEffect(() => {
    const instance = terminalInstances.get(leafId);
    if (instance) {
      instance.term.options.fontSize = fontSize;
      instance.term.options.fontFamily = fontFamily;
      instance.fitAddon.fit();
    }
  }, [fontSize, fontFamily, leafId]);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver(() => {
      const instance = terminalInstances.get(leafId);
      if (instance) requestAnimationFrame(() => instance.fitAddon.fit());
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [leafId]);

  // Focus management
  useEffect(() => {
    if (focusedLeafId === leafId) {
      const instance = terminalInstances.get(leafId);
      if (instance) instance.term.focus();
    }
  }, [focusedLeafId, leafId]);

  const handleMouseDown = () => {
    if (focusedLeafId !== leafId) setFocusedLeaf(workspaceId, leafId);
  };
  const isFocused = focusedLeafId === leafId;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1e1e2e",
        opacity: isFocused ? 1 : 0.7,
        transition: "opacity 0.15s",
      }}
    />
  );
};
