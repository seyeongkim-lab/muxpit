import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { useWorkspaceStore, type AiKind } from "../stores/workspace";
import { useSettingsStore } from "../stores/settings";
import { usePrefixStore } from "../stores/prefix";
import { useHistoryStore } from "../stores/history";
import { matchesPrefixKey } from "../utils/prefixKey";
import { shouldShowNotificationForTarget } from "../utils/notificationRouting";
import { playNotificationSound } from "../utils/notificationSound";
import { type PtyExit, type PtyOutput, spawnTerminalPty } from "../utils/ptyBackend";
import { consumePtyEventsForId, describePtyExit } from "../utils/ptyEvents";
import { isLinuxWebKitRuntime } from "../utils/runtimePlatform";
import {
  buildShellHistoryHookContext,
  shouldInjectShellHistoryHook,
  SHELL_HISTORY_HOOK,
} from "../utils/shellIntegration";
import {
  parseSshCommandLine,
  sshConnectionToArgv,
  type SshConnection,
} from "../utils/sshConnection";
import { decideTerminalInput } from "../utils/terminalInput";
import { parseTerminalOutputEvents, type TerminalOutputEvent } from "../utils/terminalOutput";
import { tauriPtyBackend } from "../utils/tauriPtyBackend";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { useNotificationStore } from "../stores/notifications";
import { getResolvedTheme } from "../themes";
import { terminalInstances } from "./terminalRegistry";
import { createTerminalSurface } from "./terminalSurface";

// Exponential backoff between tmux-CC reconnection attempts.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

const handleTerminalOutputEvent = (event: TerminalOutputEvent, workspaceId: string, leafId: string) => {
  const patchInfo = useWorkspaceInfoStore.getState().patchInfo;
  switch (event.type) {
    case "cwd":
      patchInfo(workspaceId, { cwd: event.cwd });
      return;
    case "title":
      patchInfo(workspaceId, { terminalTitle: event.title });
      return;
    case "notification":
      if (!shouldShowNotificationForTarget(workspaceId, leafId)) return;
      useNotificationStore.getState().addNotification(workspaceId, event.title, event.body);
      playNotificationSound();
      invoke("send_notification", { title: event.title, body: event.body }).catch(() => {});
      return;
    case "gitBranch":
      patchInfo(workspaceId, { gitBranch: event.branch });
      return;
    case "historyCommand":
      useHistoryStore.getState().addEntry(workspaceId, leafId, event.command);
      return;
  }
};

// Strip the "data:image/png;base64," prefix; the backend wants raw base64.
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const SHOULD_CLEAR_INPUT_TEXTAREA_AFTER_COMMIT = isLinuxWebKitRuntime();

interface TerminalLeafProps {
  workspaceId: string;
  leafId: string;
}

interface SpawnSpec {
  command?: string;
  commandArgv?: string[];
  sshConnection?: SshConnection;
}

const spawnSpecFromLeaf = (node: any): SpawnSpec => {
  const parsed = parseSshCommandLine(node.command ?? node.sshCommand);
  const sshConnection = node.sshConnection && parsed?.connection?.ttyMode && !node.sshConnection.ttyMode
    ? { ...node.sshConnection, ttyMode: parsed.connection.ttyMode }
    : node.sshConnection ?? parsed?.connection;
  const sshRemoteCommand = node.sshRemoteCommand ?? parsed?.remoteCommand;
  const command = node.command ?? node.sshCommand;
  return {
    command,
    commandArgv: sshConnection
      ? sshConnectionToArgv(sshConnection, {
          preserveTtyMode: true,
          remoteCommand: sshRemoteCommand,
        })
      : undefined,
    sshConnection,
  };
};

const findSpawnSpec = (wsId: string, leafId: string): SpawnSpec => {
  const state = useWorkspaceStore.getState();
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return {};
  const find = (node: any): SpawnSpec | undefined => {
    if (node.type === "leaf" && node.id === leafId) return spawnSpecFromLeaf(node);
    if (node.type === "split") return find(node.children[0]) ?? find(node.children[1]);
    return undefined;
  };
  return find(ws.layout) ?? {};
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

const findTmuxSession = (wsId: string, leafId: string): string | undefined => {
  const state = useWorkspaceStore.getState();
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return undefined;
  const find = (node: any): string | undefined => {
    if (node.type === "leaf" && node.id === leafId) return node.tmuxSession;
    if (node.type === "split") return find(node.children[0]) ?? find(node.children[1]);
    return undefined;
  };
  return find(ws.layout);
};

const findAiKind = (wsId: string, leafId: string): AiKind | undefined => {
  const state = useWorkspaceStore.getState();
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return undefined;
  const find = (node: any): AiKind | undefined => {
    if (node.type === "leaf" && node.id === leafId) return node.aiKind;
    if (node.type === "split") return find(node.children[0]) ?? find(node.children[1]);
    return undefined;
  };
  return find(ws.layout);
};

const leafExists = (wsId: string, leafId: string): boolean => {
  const state = useWorkspaceStore.getState();
  const ws = state.workspaces.find((w) => w.id === wsId);
  if (!ws) return false;
  const find = (node: any): boolean => {
    if (node.type === "leaf") return node.id === leafId;
    if (node.type === "split") return find(node.children[0]) || find(node.children[1]);
    return false;
  };
  return find(ws.layout);
};

export const TerminalLeaf = ({ workspaceId, leafId }: TerminalLeafProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const disposedRef = useRef(false);
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
      existing.surface.attachTo(containerRef.current);
      requestAnimationFrame(() => {
        existing.surface.fit();
        existing.surface.focus();
      });
      return;
    }

    initializedRef.current = true;

    const settings = useSettingsStore.getState();
    const surface = createTerminalSurface({
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      theme: getResolvedTheme(settings.themeName, settings.customColors),
      enableWebglRenderer: settings.enableWebglRenderer,
      clearInputTextareaAfterCommit: SHOULD_CLEAR_INPUT_TEXTAREA_AFTER_COMMIT,
      openLink: (uri) => open(uri).catch(() => {}),
    });

    // Declared here (assigned after the spawn-source resolution below) so the
    // key handler and pty-exit listener can reference it without hitting the
    // temporal dead zone on early keypresses.
    let spawnCommand: string | null = null;
    let spawnCommandArgv: string[] | null = null;
    let spawnSshConnection: SshConnection | null = null;

    // Ctrl+V entry point. A clipboard image on an SSH pane is uploaded to the
    // remote host and its path pasted instead — AI CLIs (claude etc.) running
    // over SSH can only read files on their own machine, never the local
    // clipboard. Everything else falls back to plain text paste.
    const pasteClipboard = async () => {
      let image: Blob | null = null;
      if (spawnCommand) {
        try {
          for (const item of await navigator.clipboard.read()) {
            const type = item.types.find((t) => t.startsWith("image/"));
            if (type) {
              image = await item.getType(type);
              break;
            }
          }
        } catch {
          // clipboard.read() denied/unsupported → treat as text-only clipboard
        }
      }
      if (image && spawnCommand) {
        try {
          const remotePath = await tauriPtyBackend.pushImageToRemote({
            sshCommand: spawnCommand,
            sshConnection: spawnSshConnection,
            imageBase64: await blobToBase64(image),
          });
          surface.paste(remotePath + " ");
        } catch (err) {
          console.error("[wmux] image paste failed:", err);
          surface.write(`\r\n\x1b[31m[image upload failed: ${err}]\x1b[0m\r\n`);
        }
        return;
      }
      const text = await navigator.clipboard.readText().catch(() => "");
      if (text) surface.paste(text);
    };

    // Clipboard & shortcut handling
    surface.attachCustomKeyEventHandler((e) => {
      const prefSt = usePrefixStore.getState();
      const selection = e.ctrlKey && e.key === "c" ? surface.getSelection() : "";
      const decision = decideTerminalInput(e, {
        prefixActive: prefSt.active,
        historyOpen: prefSt.historyOpen,
        prefixKeyMatches: matchesPrefixKey(e, useSettingsStore.getState().prefixKey),
        hasSelection: !!selection,
      });

      switch (decision.kind) {
        case "allowTerminalInput":
          return true;
        case "copySelection":
          navigator.clipboard.writeText(selection);
          surface.clearSelection();
          return false;
        case "pasteClipboard":
          e.preventDefault();
          pasteClipboard();
          return false;
        case "blockTerminalInput":
          return false;
      }
    });

    surface.open(containerRef.current);

    // Defer to next frame so document-level zoom (set by App.tsx via the settings store)
    // has taken effect on layout before the terminal measures the container. Without this,
    // the fit pass sees the pre-zoom pixel size and picks too few cols/rows, leaving
    // top/right gaps.
    requestAnimationFrame(() => surface.fit());

    // Set up event listeners BEFORE spawning PTY to avoid missing output.
    // Race: the Rust reader thread starts emitting "pty-output" *before* the
    // spawn_pty invoke returns with the id, so events arriving between listener
    // registration and id assignment can't be filtered yet. Buffer them all and
    // replay after the id is known. Empty terminals on session restore were
    // caused by the initial shell prompt being dropped in that window.
    let ptyId = 0;
    let idAssigned = false;
    const bufferedOutput: PtyOutput[] = [];
    const bufferedExit: PtyExit[] = [];
    const reconnectOutput: PtyOutput[] = [];
    const reconnectExit: PtyExit[] = [];
    const tmuxSession = findTmuxSession(workspaceId, leafId);

    const handleOutput = (payload: PtyOutput) => {
      const data = payload.data;
      surface.write(data);
      if (data.includes("\x1b]")) {
        for (const event of parseTerminalOutputEvents(data)) {
          handleTerminalOutputEvent(event, workspaceId, leafId);
        }
      }
    };

    const unlistenOutput = await tauriPtyBackend.onOutput((payload) => {
      if (!idAssigned) {
        bufferedOutput.push(payload);
        return;
      }
      if (payload.id === ptyId) handleOutput(payload);
      else if (reconnecting && payload.surfaceId === leafId) {
        reconnectOutput.push(payload);
      }
    });

    // Guard against overlapping reconnect loops when pty-exit fires multiple times
    // (e.g. both the child-watcher and reader thread report EOF).
    let reconnecting = false;

    const tryReconnect = async (sshCommand: string, sessionName: string) => {
      if (reconnecting) return;
      reconnecting = true;
      try {
        for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
          const delay = RECONNECT_BACKOFF_MS[i];
          surface.write(
            `\r\n\x1b[33m[disconnected — reconnecting in ${delay / 1000}s ` +
              `(attempt ${i + 1}/${RECONNECT_BACKOFF_MS.length})]\x1b[0m\r\n`,
          );
          await new Promise((r) => setTimeout(r, delay));
          // If the terminal was destroyed while we were waiting, bail out.
          if (!terminalInstances.has(leafId)) return;
          try {
            const oldId = ptyId;
            const newId = await spawnTerminalPty(tauriPtyBackend, {
              rows: Math.max(surface.rows, 1),
              cols: Math.max(surface.cols, 1),
              spawnCommand: sshCommand,
              spawnCommandArgv: null,
              spawnSshConnection,
              tmuxSession: sessionName,
              workspaceId,
              leafId,
            });
            const inst = terminalInstances.get(leafId);
            if (!inst) {
              tauriPtyBackend.kill(newId).catch(() => {});
              return;
            }
            ptyId = newId;
            inst.ptyId = newId;
            setPtyId(workspaceId, leafId, newId);
            if (oldId && oldId !== newId) {
              tauriPtyBackend.kill(oldId).catch(() => {});
            }
            for (const payload of consumePtyEventsForId(reconnectOutput, newId)) {
              handleOutput(payload);
            }
            const exits = consumePtyEventsForId(reconnectExit, newId);
            if (exits.length > 0) {
              throw new Error(describePtyExit(exits[0].code));
            }
            surface.write(`\x1b[32m[reconnected]\x1b[0m\r\n`);
            return;
          } catch (err) {
            reconnectOutput.length = 0;
            reconnectExit.length = 0;
            const msg = err instanceof Error ? err.message : String(err);
            surface.write(`\x1b[31m[reconnect attempt failed: ${msg}]\x1b[0m\r\n`);
          }
        }
        surface.write(`\r\n\x1b[31m[reconnect gave up after ${RECONNECT_BACKOFF_MS.length} attempts]\x1b[0m\r\n`);
      } finally {
        reconnecting = false;
      }
    };

    const handleExit = (_payload: PtyExit) => {
      // Tmux-CC persist mode: attempt to re-attach the remote session.
      if (tmuxSession && spawnCommand) {
        tryReconnect(spawnCommand, tmuxSession);
      } else {
        surface.write("\r\n\x1b[31m[Process exited]\x1b[0m\r\n");
      }
    };

    const unlistenExit = await tauriPtyBackend.onExit((payload) => {
      if (!idAssigned) {
        bufferedExit.push(payload);
        return;
      }
      if (payload.id === ptyId) {
        handleExit(payload);
      } else if (reconnecting && payload.surfaceId === leafId) {
        reconnectExit.push(payload);
      }
    });

    const onData = surface.onData((data) => {
      // ptyId stays 0 until spawn returns; don't forward input to PTY 0.
      if (ptyId === 0) return;
      tauriPtyBackend.write(ptyId, data).catch(console.error);
      surface.clearInputBufferAfterPrintableCommit(data);
    });

    const onResize = surface.onResize(({ rows, cols }) => {
      if (ptyId === 0) return;
      tauriPtyBackend.resize(ptyId, rows, cols).catch(console.error);
    });

    const cleanupUnregisteredTerminal = () => {
      unlistenOutput();
      unlistenExit();
      onData.dispose();
      onResize.dispose();
      surface.dispose();
    };

    const isCancelled = () => disposedRef.current || !leafExists(workspaceId, leafId);
    if (isCancelled()) {
      cleanupUnregisteredTerminal();
      return;
    }

    // Determine command to run: explicit leaf command first (split inheritance / session restore),
    // then fall back to cloning parent PTY's SSH context.
    const cloneFromPtyId = findCloneFromPtyId(workspaceId, leafId);
    const savedSpec = findSpawnSpec(workspaceId, leafId);
    if (savedSpec.command || savedSpec.commandArgv) {
      spawnCommand = savedSpec.command ?? null;
      spawnCommandArgv = savedSpec.commandArgv ?? null;
      spawnSshConnection = savedSpec.sshConnection ?? null;
    } else if (cloneFromPtyId) {
      try {
        const ctx = await tauriPtyBackend.getShellContext(cloneFromPtyId);
        if (ctx.ssh_command) {
          const parsed = parseSshCommandLine(ctx.ssh_command);
          spawnCommand = ctx.ssh_command;
          spawnCommandArgv = parsed
            ? sshConnectionToArgv(parsed.connection, {
                preserveTtyMode: true,
                remoteCommand: parsed.remoteCommand,
              })
            : null;
          spawnSshConnection = parsed?.connection ?? null;
        }
      } catch {
        // Silently ignore context fetch errors
      }
    }

    // Spawn PTY — with command for SSH direct execution, or null for default shell.
    // If spawning with an explicit command fails (e.g. ssh binary missing after a
    // session restore), fall back to the default shell so the pane is usable instead
    // of leaving a silent empty terminal.
    try {
      ptyId = await spawnTerminalPty(tauriPtyBackend, {
        rows: Math.max(surface.rows, 1),
        cols: Math.max(surface.cols, 1),
        spawnCommand,
        spawnCommandArgv,
        spawnSshConnection,
        tmuxSession,
        workspaceId,
        leafId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      surface.write(`\r\n\x1b[31m[spawn failed: ${msg}]\x1b[0m\r\n`);
      if (spawnCommand) {
        surface.write(`\x1b[33m[retrying with default shell]\x1b[0m\r\n`);
        try {
          ptyId = await tauriPtyBackend.spawn({
            rows: Math.max(surface.rows, 1),
            cols: Math.max(surface.cols, 1),
            command: null,
            commandArgv: null,
            workspaceId,
            surfaceId: leafId,
          });
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          surface.write(`\r\n\x1b[31m[default shell also failed: ${msg2}]\x1b[0m\r\n`);
          unlistenOutput();
          unlistenExit();
          onData.dispose();
          onResize.dispose();
          return;
        }
      } else {
        unlistenOutput();
        unlistenExit();
        onData.dispose();
        onResize.dispose();
        return;
      }
    }

    if (isCancelled()) {
      if (ptyId !== 0) {
        tauriPtyBackend.kill(ptyId).catch(() => {});
      }
      cleanupUnregisteredTerminal();
      return;
    }

    // Mark id as assigned and drain any events that arrived during the spawn
    // window. Runs synchronously before any further awaits, so no other event
    // handlers can interleave and reorder output.
    idAssigned = true;
    for (const payload of bufferedOutput) {
      if (payload.id === ptyId) handleOutput(payload);
    }
    bufferedOutput.length = 0;
    for (const payload of bufferedExit) {
      if (payload.id === ptyId) {
        handleExit(payload);
      }
    }
    bufferedExit.length = 0;

    terminalInstances.set(leafId, {
      surface,
      ptyId,
      cleanup: { unlistenOutput, unlistenExit, onData, onResize },
    });

    // Trigger state update LAST, after everything is set up
    setPtyId(workspaceId, leafId, ptyId);

    // For non-SSH clones, replicate local cwd
    if (cloneFromPtyId && !spawnCommand) {
      try {
        const ctx = await tauriPtyBackend.getShellContext(cloneFromPtyId);
        if (ctx.cwd) {
          setTimeout(() => {
            tauriPtyBackend.write(ptyId, `cd "${ctx.cwd}"\r`).catch(() => {});
          }, 500);
        }
      } catch {
        // Silently ignore
      }
    }

    // Inject shell history hook (bash + zsh). Skip:
    //   - AI CLI panes (their prompt is not a plain shell)
    //   - tmux-persist panes (the hook ends with `clear`, which erases the existing tmux
    //     screen on reconnect — history is already captured when the session was first started)
    //   - PowerShell / cmd panes (POSIX `[ -n ... ]` syntax raises a ParserError)
    if (
      shouldInjectShellHistoryHook(
        buildShellHistoryHookContext(findAiKind(workspaceId, leafId), spawnCommand, tmuxSession),
      )
    ) {
      setTimeout(() => {
        tauriPtyBackend.write(ptyId, SHELL_HISTORY_HOOK).catch(() => {});
      }, 700);
    }

    surface.focus();
  }, [workspaceId, leafId, setPtyId]);

  useEffect(() => {
    disposedRef.current = false;
    initTerminal().catch((err) => {
      console.error(`[wmux] initTerminal failed for leaf ${leafId}:`, err);
    });
    return () => {
      disposedRef.current = true;
    };
  }, [initTerminal, leafId]);

  // Apply font settings changes to existing terminals.
  // The current terminal surface renders its own canvas, so Chromium's `zoom` on <html> (used by App.tsx to
  // scale the chrome) does not reach the WebGL canvas. The terminal font must be
  // resized through the surface options. fit() runs in the next frame because the
  // zoom useEffect in App.tsx also fires on fontSize changes and the relative order
  // isn't guaranteed — waiting a frame ensures zoom is already applied.
  useEffect(() => {
    const instance = terminalInstances.get(leafId);
    if (instance) {
      instance.surface.setFont(fontSize, fontFamily);
      requestAnimationFrame(() => instance.surface.fit());
    }
  }, [fontSize, fontFamily, leafId]);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver(() => {
      const instance = terminalInstances.get(leafId);
      if (instance) requestAnimationFrame(() => instance.surface.fit());
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [leafId]);

  // Focus management — only force-focus when the browser focus is NOT already
  // inside this terminal. A mousedown on an unfocused pane triggers
  // `setFocusedLeaf`, which re-runs this effect; calling focus() during
  // an active drag selection yanks focus to the helper textarea and clears the
  // selection before `mouseup`, so the user cannot copy by drag. Native click
  // already focuses the terminal, so skipping the explicit focus() in that path is safe.
  useEffect(() => {
    if (focusedLeafId !== leafId) return;
    const instance = terminalInstances.get(leafId);
    if (!instance) return;
    if (instance.surface.containsActiveElement(document.activeElement)) return;
    instance.surface.focus();
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
