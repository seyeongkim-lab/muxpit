import { useCallback, useEffect, useRef } from "react";
import { useHistoryStore } from "../stores/history";
import { useNotificationStore } from "../stores/notifications";
import { usePrefixStore } from "../stores/prefix";
import { useSettingsStore } from "../stores/settings";
import { useWorkspaceStore } from "../stores/workspace";
import { getResolvedTheme } from "../themes";
import { useWorkspaceInfoStore } from "./useWorkspaceInfo";
import { shouldShowNotificationForTarget } from "../utils/notificationRouting";
import { playNotificationSound } from "../utils/notificationSound";
import { matchesPrefixKey } from "../utils/prefixKey";
import { type PtyExit, type PtyOutput, spawnTerminalPty } from "../utils/ptyBackend";
import { consumePtyEventsForId, describePtyExit } from "../utils/ptyEvents";
import { getRuntimePlatform, isLinuxWebKitRuntime } from "../utils/runtimePlatform";
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
import { createTerminalClipboard } from "../utils/terminalClipboard";
import { decideTerminalInput, shouldReadTerminalSelectionForInput } from "../utils/terminalInput";
import {
  pasteTerminalClipboard,
  pasteTerminalPasteEvent,
} from "../utils/terminalPaste";
import {
  findTerminalAiKind,
  findTerminalCloneFromPtyId,
  findTerminalSpawnSpec,
  findTerminalTmuxSession,
  terminalLeafExists,
} from "../utils/terminalSessionLayout";
import { buildTerminalSpawnPlan } from "../utils/terminalSpawnPlan";
import { TerminalOutputParser, type TerminalOutputEvent } from "../utils/terminalOutput";
import { terminalInstances } from "../components/terminalRegistry";
import { createTerminalSurface, type TerminalSurface } from "../components/terminalSurface";
import { appInvoke, openExternalUrl } from "../utils/appBridge";
import { getPtyBackend } from "../utils/runtimePtyBackend";

// Exponential backoff between tmux-CC reconnection attempts.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

const SHOULD_CLEAR_STALE_INPUT_BUFFER_AFTER_TEXT_INPUT = isLinuxWebKitRuntime();
const TERMINAL_INPUT_PLATFORM = getRuntimePlatform();

interface UseTerminalSessionOptions {
  workspaceId: string;
  leafId: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  initializedRef: React.MutableRefObject<boolean>;
}

const handleTerminalOutputEvent = (event: TerminalOutputEvent, workspaceId: string, leafId: string) => {
  const patchInfo = useWorkspaceInfoStore.getState().patchInfo;
  switch (event.type) {
    case "cwd":
      patchInfo(workspaceId, { cwd: event.cwd });
      if (useSettingsStore.getState().enableExperimentalCwdRestore) {
        useWorkspaceStore.getState().setLeafCwd(workspaceId, leafId, event.cwd);
      }
      return;
    case "title":
      patchInfo(workspaceId, { terminalTitle: event.title });
      return;
    case "notification":
      if (!shouldShowNotificationForTarget(workspaceId, leafId)) return;
      useNotificationStore.getState().addNotification(workspaceId, event.title, event.body);
      playNotificationSound();
      appInvoke("send_notification", { title: event.title, body: event.body }).catch(() => {});
      return;
    case "gitBranch":
      patchInfo(workspaceId, { gitBranch: event.branch });
      return;
    case "historyCommand":
      useHistoryStore.getState().addEntry(workspaceId, leafId, event.command);
      return;
  }
};

const createConfiguredSurface = (): TerminalSurface => {
  const settings = useSettingsStore.getState();
  return createTerminalSurface({
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    theme: getResolvedTheme(settings.themeName, settings.customColors),
    enableWebglRenderer: settings.enableWebglRenderer,
    clearStaleInputBufferAfterTextInput: SHOULD_CLEAR_STALE_INPUT_BUFFER_AFTER_TEXT_INPUT,
    openLink: (uri) => openExternalUrl(uri).catch(() => {}),
  });
};

const getWorkspaces = () => useWorkspaceStore.getState().workspaces;

export const useTerminalSession = ({
  workspaceId,
  leafId,
  containerRef,
  initializedRef,
}: UseTerminalSessionOptions) => {
  const disposedRef = useRef(false);
  const setPtyId = useWorkspaceStore((s) => s.setPtyId);

  const initTerminal = useCallback(async () => {
    if (!containerRef.current || initializedRef.current) return;

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
    const surface = createConfiguredSurface();
    const ptyBackend = getPtyBackend();

    // Declared here (assigned after the spawn-source resolution below) so the
    // key handler and pty-exit listener can reference it without hitting the
    // temporal dead zone on early keypresses.
    let spawnCommand: string | null = null;
    let spawnCommandArgv: string[] | null = null;
    let spawnSshConnection: SshConnection | null = null;
    const clipboard = createTerminalClipboard();

    // Ctrl+V entry point. Text is preferred when the OS clipboard exposes both
    // text and image flavors; image-only clipboards are saved locally or on the
    // SSH host and paste the resulting path.
    const pasteClipboard = async () => {
      await pasteTerminalClipboard({
        clipboard,
        imageStore: ptyBackend,
        surface,
        spawnCommand,
        spawnSshConnection,
        platform: TERMINAL_INPUT_PLATFORM,
      });
    };

    surface.attachCustomKeyEventHandler((event) => {
      const prefSt = usePrefixStore.getState();
      const selection = shouldReadTerminalSelectionForInput(event) ? surface.getSelection() : "";
      const decision = decideTerminalInput(event, {
        prefixActive: prefSt.active,
        historyOpen: prefSt.historyOpen,
        prefixKeyMatches: matchesPrefixKey(event, useSettingsStore.getState().prefixKey),
        hasSelection: !!selection,
      }, TERMINAL_INPUT_PLATFORM);

      switch (decision.kind) {
        case "allowTerminalInput":
          return true;
        case "allowNativeClipboard":
          return false;
        case "copySelection":
          clipboard.writeText(selection);
          surface.clearSelection();
          return false;
        case "pasteClipboard":
          event.preventDefault();
          pasteClipboard();
          return false;
        case "blockTerminalInput":
          return false;
      }
    });

    surface.open(containerRef.current);
    requestAnimationFrame(() => surface.fit());

    const onPaste = surface.onPaste((event) => {
      pasteTerminalPasteEvent({
        event,
        clipboard,
        imageStore: ptyBackend,
        surface,
        spawnCommand,
        spawnSshConnection,
        platform: TERMINAL_INPUT_PLATFORM,
      });
    });

    // Set up event listeners BEFORE spawning PTY to avoid missing output.
    // Race: the Rust reader thread starts emitting "pty-output" before the
    // spawn_pty invoke returns with the id, so events arriving in that window
    // are buffered and replayed after the id is known.
    let ptyId = 0;
    let idAssigned = false;
    const bufferedOutput: PtyOutput[] = [];
    const bufferedExit: PtyExit[] = [];
    const reconnectOutput: PtyOutput[] = [];
    const reconnectExit: PtyExit[] = [];
    const tmuxSession = findTerminalTmuxSession(getWorkspaces(), workspaceId, leafId);
    const outputParser = new TerminalOutputParser({ platform: TERMINAL_INPUT_PLATFORM });

    const handleOutput = (payload: PtyOutput) => {
      const data = payload.data;
      surface.write(data);
      for (const event of outputParser.parse(data)) {
        handleTerminalOutputEvent(event, workspaceId, leafId);
      }
    };

    const unlistenOutput = await ptyBackend.onOutput((payload) => {
      if (!idAssigned) {
        bufferedOutput.push(payload);
        return;
      }
      if (payload.id === ptyId) handleOutput(payload);
      else if (reconnecting && payload.surfaceId === leafId) {
        reconnectOutput.push(payload);
      }
    });

    let reconnecting = false;

    const tryReconnect = async (sshCommand: string, sessionName: string) => {
      if (reconnecting) return;
      reconnecting = true;
      try {
        for (let i = 0; i < RECONNECT_BACKOFF_MS.length; i++) {
          const delay = RECONNECT_BACKOFF_MS[i];
          surface.write(
            `\r\n\x1b[33m[disconnected - reconnecting in ${delay / 1000}s ` +
              `(attempt ${i + 1}/${RECONNECT_BACKOFF_MS.length})]\x1b[0m\r\n`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (!terminalInstances.has(leafId)) return;
          try {
            const oldId = ptyId;
            const newId = await spawnTerminalPty(ptyBackend, {
              rows: Math.max(surface.rows, 1),
              cols: Math.max(surface.cols, 1),
              spawnCommand: sshCommand,
              spawnCommandArgv: null,
              spawnSshConnection,
              tmuxSession: sessionName,
              workspaceId,
              leafId,
            });
            const instance = terminalInstances.get(leafId);
            if (!instance) {
              ptyBackend.kill(newId).catch(() => {});
              return;
            }
            ptyId = newId;
            instance.ptyId = newId;
            setPtyId(workspaceId, leafId, newId);
            if (oldId && oldId !== newId) {
              ptyBackend.kill(oldId).catch(() => {});
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
      if (tmuxSession && spawnCommand) {
        tryReconnect(spawnCommand, tmuxSession);
      } else {
        surface.write("\r\n\x1b[31m[Process exited]\x1b[0m\r\n");
      }
    };

    const unlistenExit = await ptyBackend.onExit((payload) => {
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
      if (ptyId === 0) return;
      ptyBackend.write(ptyId, data).catch(console.error);
      surface.clearStaleInputBufferAfterTextInput(data);
    });

    const onResize = surface.onResize(({ rows, cols }) => {
      if (ptyId === 0) return;
      ptyBackend.resize(ptyId, rows, cols).catch(console.error);
    });

    const cleanupUnregisteredTerminal = () => {
      unlistenOutput();
      unlistenExit();
      onData.dispose();
      onResize.dispose();
      onPaste.dispose();
      surface.dispose();
    };

    const isCancelled = () =>
      disposedRef.current ||
      !terminalLeafExists(getWorkspaces(), workspaceId, leafId);
    if (isCancelled()) {
      cleanupUnregisteredTerminal();
      return;
    }

    const cloneFromPtyId = findTerminalCloneFromPtyId(getWorkspaces(), workspaceId, leafId);
    const savedSpec = findTerminalSpawnSpec(getWorkspaces(), workspaceId, leafId);
    const settings = useSettingsStore.getState();
    if (savedSpec.command || savedSpec.commandArgv) {
      spawnCommand = savedSpec.command ?? null;
      spawnCommandArgv = savedSpec.commandArgv ?? null;
      spawnSshConnection = savedSpec.sshConnection ?? null;
    } else if (cloneFromPtyId) {
      try {
        const ctx = await ptyBackend.getShellContext(cloneFromPtyId);
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
        // Silently ignore context fetch errors.
      }
    }
    const aiKind = findTerminalAiKind(getWorkspaces(), workspaceId, leafId);
    const spawnPlan = buildTerminalSpawnPlan({
      spec: savedSpec,
      resolved: {
        command: spawnCommand,
        commandArgv: spawnCommandArgv,
        sshConnection: spawnSshConnection,
      },
      tmuxSession,
      aiKind,
      settings: {
        enableCwdRestore: settings.enableExperimentalCwdRestore,
        enableAgentSessionRestore: settings.enableExperimentalAgentSessionRestore,
        enableAgentDangerousResume: settings.enableExperimentalAgentDangerousResume,
      },
    });
    spawnCommand = spawnPlan.spawnCommand;
    spawnCommandArgv = spawnPlan.spawnCommandArgv;
    spawnSshConnection = spawnPlan.spawnSshConnection;

    try {
      ptyId = await spawnTerminalPty(ptyBackend, {
        rows: Math.max(surface.rows, 1),
        cols: Math.max(surface.cols, 1),
        spawnCommand,
        spawnCommandArgv,
        spawnSshConnection,
        tmuxSession,
        cwd: spawnPlan.cwd,
        enableCwdReporting: spawnPlan.enableCwdReporting,
        enableAgentSessionReporting: spawnPlan.enableAgentSessionReporting,
        workspaceId,
        leafId,
      });
      if (spawnPlan.postSpawnInput) {
        ptyBackend.write(ptyId, spawnPlan.postSpawnInput).catch(console.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      surface.write(`\r\n\x1b[31m[spawn failed: ${msg}]\x1b[0m\r\n`);
      if (spawnCommand) {
        surface.write(`\x1b[33m[retrying with default shell]\x1b[0m\r\n`);
        try {
          ptyId = await ptyBackend.spawn({
            rows: Math.max(surface.rows, 1),
            cols: Math.max(surface.cols, 1),
            command: null,
            commandArgv: null,
            cwd: spawnPlan.cwd,
            enableCwdReporting: spawnPlan.enableCwdReporting,
            enableAgentSessionReporting: spawnPlan.enableAgentSessionReporting,
            workspaceId,
            surfaceId: leafId,
          });
          if (spawnPlan.fallbackPostSpawnInput) {
            ptyBackend.write(ptyId, spawnPlan.fallbackPostSpawnInput).catch(console.error);
          }
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          surface.write(`\r\n\x1b[31m[default shell also failed: ${msg2}]\x1b[0m\r\n`);
          unlistenOutput();
          unlistenExit();
          onData.dispose();
          onResize.dispose();
          onPaste.dispose();
          return;
        }
      } else {
        unlistenOutput();
        unlistenExit();
        onData.dispose();
        onResize.dispose();
        onPaste.dispose();
        return;
      }
    }

    if (isCancelled()) {
      if (ptyId !== 0) {
        ptyBackend.kill(ptyId).catch(() => {});
      }
      cleanupUnregisteredTerminal();
      return;
    }

    idAssigned = true;
    for (const payload of bufferedOutput) {
      if (payload.id === ptyId) handleOutput(payload);
    }
    bufferedOutput.length = 0;
    for (const payload of bufferedExit) {
      if (payload.id === ptyId) handleExit(payload);
    }
    bufferedExit.length = 0;

    terminalInstances.set(leafId, {
      surface,
      ptyId,
      cleanup: { unlistenOutput, unlistenExit, onData, onResize, onPaste },
    });

    setPtyId(workspaceId, leafId, ptyId);

    // The spawn size is captured before the first fit settles. Over a WS backend
    // the spawn round-trip can outlast that fit, so the fit's resize event fires
    // while `ptyId` is still undefined and is lost — leaving the pty (and tmux)
    // stuck at the pre-fit size. Re-fit once the pty exists and push the current
    // size explicitly (the fit alone emits onResize only when the size changes).
    requestAnimationFrame(() => {
      if (disposedRef.current) return;
      surface.fit();
      ptyBackend.resize(ptyId, Math.max(surface.rows, 1), Math.max(surface.cols, 1)).catch(() => {});
    });

    if (cloneFromPtyId && !spawnCommand && !spawnPlan.postSpawnInput) {
      try {
        const ctx = await ptyBackend.getShellContext(cloneFromPtyId);
        if (ctx.cwd) {
          setTimeout(() => {
            ptyBackend.write(ptyId, `cd "${ctx.cwd}"\r`).catch(() => {});
          }, 500);
        }
      } catch {
        // Silently ignore.
      }
    }

    if (
      shouldInjectShellHistoryHook(
        buildShellHistoryHookContext(
          findTerminalAiKind(getWorkspaces(), workspaceId, leafId),
          spawnCommand,
          tmuxSession,
          TERMINAL_INPUT_PLATFORM,
        ),
      ) &&
      !spawnPlan.suppressShellHistoryHook
    ) {
      setTimeout(() => {
        ptyBackend.write(ptyId, SHELL_HISTORY_HOOK).catch(() => {});
      }, 700);
    }

    surface.focus();
  }, [containerRef, initializedRef, leafId, setPtyId, workspaceId]);

  useEffect(() => {
    disposedRef.current = false;
    initTerminal().catch((err) => {
      console.error(`[wmux] initTerminal failed for leaf ${leafId}:`, err);
    });
    return () => {
      disposedRef.current = true;
    };
  }, [initTerminal, leafId]);
};
