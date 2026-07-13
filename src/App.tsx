import { useEffect, useState, useRef, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { FilesRail } from "./components/FilesRail";
import { SplitPane } from "./components/SplitPane";
import { TopDashboardBar } from "./components/TopDashboardBar";
import { WindowControls } from "./components/WindowControls";
import { GridOverview } from "./components/GridOverview";
import { NotificationPanel } from "./components/NotificationPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SshHostPanel } from "./components/SshHostPanel";
import { PrefixIndicator } from "./components/PrefixIndicator";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { PaneNumberOverlay } from "./components/PaneNumberOverlay";
import { HistoryPanel } from "./components/HistoryPanel";
import { LaunchProfilesPanel } from "./components/LaunchProfilesPanel";
import { useWorkspaceStore, collectLeafIds, findLeafByPtyId } from "./stores/workspace";
import {
  buildSshConnection,
  buildSshCommand,
  buildSshCommandWithRemoteCmdFromBase,
  quotePosixShellArg,
  type SshHost,
} from "./stores/sshHosts";
import { useAiCliStore, buildAiLaunchSpec, parseSshTarget } from "./stores/aiCli";
import { useNotificationStore } from "./stores/notifications";
import { useAgentTaskStore } from "./stores/agentTasks";
import { useLaunchProfileStore } from "./stores/launchProfiles";
import { getTmuxActivePaneCwd, useTmuxSessionsStore } from "./stores/tmuxSessions";
import { useSettingsStore } from "./stores/settings";
import { usePrefixStore, PREFIX_TIMEOUT_MS, PANE_NUMBER_TIMEOUT_MS } from "./stores/prefix";
import { destroyTerminal, destroyAllTerminals, terminalInstances } from "./components/terminalRegistry";
import { useWorkspaceInfoPoller, useSshContextPoller, useWorkspaceInfoStore } from "./hooks/useWorkspaceInfo";
import { useAgentSessionProcessMonitor } from "./hooks/useAgentSessionProcessMonitor";
import { applyThemeVars, getResolvedTheme } from "./themes";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { LayoutNode, LeafNode } from "./stores/workspace";
import {
  findNeighbor,
  computeResize,
  collectOrderedLeaves,
  collectRects,
  type Direction,
} from "./utils/layoutGeometry";
import { shouldShowNotificationForTarget } from "./utils/notificationRouting";
import { playNotificationSound } from "./utils/notificationSound";
import { matchesPrefixKey } from "./utils/prefixKey";
import { getRuntimePlatform } from "./utils/runtimePlatform";
import {
  aiStatusFromAgentSessionEvent,
  aiStatusFromHookNotification,
} from "./utils/aiTerminalStatus";
import { sanitizeTmuxSessionName } from "./utils/tmuxSession";
import { isTerminalCompositionKeyEvent } from "./utils/terminalInput";
import { isAgentSessionEndEvent, isRestorableAgentKind } from "./utils/agentSession";
import { agentTaskStatusFromEvent } from "./utils/agentTask";
import { logInfo, logWarn } from "./utils/appLog";
import { decideAppShortcut } from "./utils/appShortcuts";
import {
  buildSshCommandWithRemoteCmdFromConnection,
  parseSshCommandLine,
  type SshConnection,
} from "./utils/sshConnection";
import { tauriPtyBackend } from "./utils/tauriPtyBackend";
import { tryGetCurrentWebview, tryGetCurrentWindow } from "./utils/tauriWindow";
import type { ControlRequestEvent } from "./utils/controlRequest";
import { executeAppControlRequest } from "./utils/controlRequestRuntime";

const APP_SHORTCUT_PLATFORM = getRuntimePlatform();

const findLeafNode = (node: LayoutNode, id: string): LeafNode | null => {
  if (node.type === "leaf") return node.id === id ? node : null;
  if (node.type === "split") return findLeafNode(node.children[0], id) ?? findLeafNode(node.children[1], id);
  return null;
};

const findFirstLeafNode = (node: LayoutNode): LeafNode | null => {
  if (node.type === "leaf") return node;
  if (node.type === "split") return findFirstLeafNode(node.children[0]) ?? findFirstLeafNode(node.children[1]);
  return null;
};

const isRemoteFileLeaf = (leaf: LeafNode | null): leaf is LeafNode => {
  if (!leaf) return false;
  if (leaf.sshConnection?.program || leaf.sshCommand) return true;
  return !!parseSshCommandLine(leaf.command);
};

// tmux control mode needs 3.2+ (window/session notifications stabilised).
const isTmuxVersionSupported = (version: string): boolean => {
  const m = version.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 3 || (major === 3 && minor >= 2);
};


/**
 * Probe the remote for installed AI CLIs and (when claude is found) auto-split a
 * second pane into it. Probe results are cached on `useAiCliStore` so the
 * per-pane toolbar can render the same set without a second SSH call.
 */
const autoAiSplit = async (wsId: string, sshCommand: string, sshConnection?: SshConnection, host?: SshHost) => {
  try {
    const target = sshConnection?.target ?? (host ? `${host.user}@${host.host}` : parseSshTarget(sshCommand));
    if (!target) return;
    const connection = sshConnection ?? (host ? buildSshConnection(host) : parseSshCommandLine(sshCommand)?.connection);

    await useAiCliStore.getState().probe(target, sshCommand, connection);
    const available = useAiCliStore.getState().available(target);
    if (!available || !available.has("claude")) return;

    const state = useWorkspaceStore.getState();
    const ws = state.workspaces.find((w) => w.id === wsId);
    if (!ws) return;

    // Skip if any AI pane already exists in this workspace. Backwards-compat:
    // leaves saved before the aiKind field landed only carry a command string,
    // so we also sniff the embedded remote command for a known AI CLI name.
    const hasAiPane = (node: LayoutNode): boolean => {
      if (node.type === "leaf") {
        if (node.aiKind) return true;
        return /(?:^|['" /])(claude|codex|gemini|copilot|opencode)\b/.test(node.command ?? "");
      }
      if (node.type === "split") return hasAiPane(node.children[0]) || hasAiPane(node.children[1]);
      return false;
    };
    if (hasAiPane(ws.layout)) return;

    const leafId = ws.layout.type === "leaf" ? ws.layout.id : ws.focusedLeafId;
    const infoState = useWorkspaceInfoStore.getState();
    const cwd = infoState.leafCwds[wsId]?.[leafId]
      ?? await getTmuxActivePaneCwd(wsId).catch(() => undefined)
      ?? infoState.info[wsId]?.cwd;
    const claude = buildAiLaunchSpec("claude", sshCommand, connection, cwd);
    useWorkspaceStore.getState().splitLeafWithCommand(wsId, leafId, "horizontal", claude.command, {
      aiKind: "claude",
      aiSshTarget: target,
      sshConnection: claude.sshConnection,
      sshRemoteCommand: claude.sshRemoteCommand,
    });
  } catch {
    // Silently ignore — probe failures already cache an empty set.
  }
};

export const App = () => {
  const { workspaces, activeId, addWorkspace, removeWorkspace, splitLeaf, closeLeaf, openBrowser } =
    useWorkspaceStore();
  const activeWs = workspaces.find((w) => w.id === activeId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sshPanelOpen, setSshPanelOpen] = useState(false);
  const [sshPanelEditId, setSshPanelEditId] = useState<string | null>(null);
  const [gridView, setGridView] = useState(false);
  const [filesRailVisible, setFilesRailVisible] = useState(true);
  const [sidebarMonitor, setSidebarMonitor] = useState<{ monitorId: string; sshTarget: string; sshCommand: string; sshConnection?: SshConnection } | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const launchProfilesOpen = useLaunchProfileStore((state) => state.panelOpen);
  const setLaunchProfilesOpen = useLaunchProfileStore((state) => state.setPanelOpen);
  const notificationPanelOpen = useNotificationStore((state) => state.panelOpen);
  const historyPanelOpen = usePrefixStore((state) => state.historyOpen);
  const paneNumbersVisible = usePrefixStore((state) => state.showPaneNumbers);
  const closingRef = useRef(false);

  const uiFontSize = useSettingsStore((s) => s.fontSize);
  const themeName = useSettingsStore((s) => s.themeName);
  const customColors = useSettingsStore((s) => s.customColors);
  const customThemes = useSettingsStore((s) => s.customThemes);
  const dashboardLayout = useSettingsStore((s) => s.dashboardLayout);
  const activeInfo = useWorkspaceInfoStore((s) => activeId ? s.info[activeId] : undefined);
  const fileLeaf = activeWs
    ? findLeafNode(activeWs.layout, activeWs.focusedLeafId) ?? findFirstLeafNode(activeWs.layout)
    : null;
  const fileLeafIsRemote = isRemoteFileLeaf(fileLeaf);
  const parsedFileSsh = fileLeafIsRemote
    ? parseSshCommandLine(fileLeaf.sshCommand ?? fileLeaf.command)
    : undefined;
  const fileRailCwd = activeInfo?.cwd || fileLeaf?.lastCwd || null;
  const fileRailSshConnection = fileLeafIsRemote
    ? fileLeaf.sshConnection ?? parsedFileSsh?.connection ?? null
    : null;
  const fileRailSshCommand = fileLeafIsRemote
    ? fileLeaf.sshCommand ?? fileLeaf.command ?? null
    : null;
  const browserVisible = !(
    settingsOpen ||
    sshPanelOpen ||
    closeConfirmOpen ||
    launchProfilesOpen ||
    notificationPanelOpen ||
    historyPanelOpen ||
    paneNumbersVisible
  );

  // Push resolved theme colours onto :root as CSS custom properties so the
  // sidebar/toolbar chrome stays in sync when the user switches themes.
  useEffect(() => {
    applyThemeVars(getResolvedTheme(themeName, customColors, customThemes));
  }, [themeName, customColors, customThemes]);

  // Use Tauri's webview page-zoom (same mechanism as Ctrl+mouse-wheel in a browser).
  // The CSS `zoom` property scales pixels after layout, so DOM APIs like clientWidth
  // still return the pre-zoom size — xterm's fitAddon then picked too few cols/rows and
  // left top/right gaps. Page zoom, by contrast, scales the viewport itself so all
  // measurements stay consistent. Baseline: fontSize=14 → zoom=1.0.
  useEffect(() => {
    const webview = tryGetCurrentWebview();
    if (!webview) return;
    webview.setZoom(uiFontSize / 14).catch((err) => console.error("[wmux] setZoom failed:", err));
  }, [uiFontSize]);

  // Poll workspace metadata (git, ports) every 5 seconds
  useWorkspaceInfoPoller(5000);
  // SSH context caching every 30 seconds (for session restore)
  useSshContextPoller(30000);
  // Codex has no native SessionEnd hook, so clear local resume bindings when
  // the Codex process disappears from the pane's PTY process tree.
  useAgentSessionProcessMonitor(2000);

  useEffect(() => {
    const settings = useSettingsStore.getState();
    logInfo(
      `frontend settings platform=${APP_SHORTCUT_PLATFORM} webgl=${settings.enableWebglRenderer} ` +
        `webglUserSet=${settings.enableWebglRendererUserSet}`,
    );

    const writeHeartbeat = () => {
      const state = useWorkspaceStore.getState();
      const leafCount = state.workspaces.reduce(
        (count, ws) => count + collectLeafIds(ws.layout).length,
        0,
      );
      logInfo(
        `frontend heartbeat visibility=${document.visibilityState} workspaces=${state.workspaces.length} ` +
          `leaves=${leafCount} terminals=${terminalInstances.size}`,
      );
    };

    const timer = window.setInterval(writeHeartbeat, 60000);
    return () => window.clearInterval(timer);
  }, []);

  // Auto-detect SSH on focused pane and show sidebar monitor (poll every 5s)
  const monitorTargetRef = useRef<string | null>(null);
  const monitorCommandRef = useRef<string | null>(null);
  const activeWsId = activeWs?.id;

  useEffect(() => {
    if (!activeWsId) {
      // No active workspace — stop monitor
      monitorTargetRef.current = null;
      monitorCommandRef.current = null;
      setSidebarMonitor((prev) => {
        if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
        return null;
      });
      return;
    }

    let cancelled = false;

    const checkSsh = async () => {
      if (cancelled) return;

      const state = useWorkspaceStore.getState();
      const ws = state.workspaces.find((w) => w.id === activeWsId);
      if (!ws) return;

      // Search all leaves in the workspace for an SSH connection
      const allLeaves: LeafNode[] = [];
      const collectLeaves = (node: LayoutNode) => {
        if (node.type === "leaf") allLeaves.push(node);
        if (node.type === "split") { collectLeaves(node.children[0]); collectLeaves(node.children[1]); }
      };
      collectLeaves(ws.layout);

      // Try focused leaf first
      const focused = allLeaves.find((l) => l.id === ws.focusedLeafId);
      const ordered = focused ? [focused, ...allLeaves.filter((l) => l !== focused)] : allLeaves;

      for (const leaf of ordered) {
        if (!leaf.ptyId) continue;

        let target: string | null = null;
        let sshCommand: string | null = null;
        let sshConnection: SshConnection | undefined;

        if (leaf.sshConnection) {
          target = leaf.sshConnection.target;
          sshCommand = leaf.command ?? buildSshCommandWithRemoteCmdFromConnection(
            leaf.sshConnection,
            leaf.sshRemoteCommand ?? "",
            !!leaf.sshRemoteCommand,
          );
          sshConnection = leaf.sshConnection;
        } else if (leaf.command && leaf.command.toLowerCase().includes("ssh")) {
          const parsed = parseSshCommandLine(leaf.command);
          target = parsed?.connection.target ?? parseSshTarget(leaf.command);
          if (target) sshCommand = leaf.command;
          sshConnection = parsed?.connection;
        }

        if (!target) {
          try {
            const ctx = await invoke<{ ssh_command: string | null }>("get_shell_ctx", { id: leaf.ptyId });
            if (!cancelled && ctx.ssh_command) {
              const parsed = parseSshCommandLine(ctx.ssh_command);
              target = parsed?.connection.target ?? parseSshTarget(ctx.ssh_command);
              if (target) sshCommand = ctx.ssh_command;
              sshConnection = parsed?.connection;
            }
          } catch {}
        }

        if (cancelled) return;

        if (target && sshCommand && sshConnection) {
          if (target !== monitorTargetRef.current || sshCommand !== monitorCommandRef.current) {
            monitorTargetRef.current = target;
            monitorCommandRef.current = sshCommand;
            setSidebarMonitor((prev) => {
              if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
              return { monitorId: `mon-${Date.now()}`, sshTarget: target!, sshCommand: sshCommand!, sshConnection };
            });
          }
          return; // Found SSH — done
        }
      }

      // No SSH found in any leaf — only clear if we explicitly have no SSH leaves
      // (don't clear if leaves exist but just don't have ptyId yet)
      const hasAnyPty = allLeaves.some((l) => l.ptyId);
      if (hasAnyPty && monitorTargetRef.current !== null) {
        // All PTYs checked, none are SSH — clear monitor
        monitorTargetRef.current = null;
        monitorCommandRef.current = null;
        setSidebarMonitor((prev) => {
          if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
          return null;
        });
      }
    };

    // Immediate check on workspace change, then poll every 5s
    checkSsh();
    const timer = setInterval(checkSsh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeWsId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore session or create initial workspace
  useEffect(() => {
    const restored = useWorkspaceStore.getState().restoreSession();
    if (!restored && workspaces.length === 0) {
      addWorkspace("Shell 1");
    }

    // Auto claude split for restored SSH workspaces, and re-attach the tmux
    // session list poller for any leaf that was persisted with a tmuxSession.
    if (restored) {
      const state = useWorkspaceStore.getState();
      for (const ws of state.workspaces) {
        // Find first SSH leaf with its tmuxSession (if any).
        const findSshLeaf = (node: LayoutNode): { cmd: string; tmuxSession: string | undefined; sshConnection?: SshConnection } | null => {
          if (node.type === "leaf") {
            const parsed = parseSshCommandLine(node.command);
            return node.sshConnection || parsed
              ? { cmd: node.command ?? "", tmuxSession: node.tmuxSession, sshConnection: node.sshConnection ?? parsed?.connection }
              : null;
          }
          if (node.type === "split") return findSshLeaf(node.children[0]) ?? findSshLeaf(node.children[1]);
          return null;
        };
        const ssh = findSshLeaf(ws.layout);
        if (ssh) {
          if (ssh.tmuxSession) {
            useTmuxSessionsStore.getState().attach(ws.id, ssh.cmd, ssh.tmuxSession, ssh.sshConnection);
          }
          autoAiSplit(ws.id, ssh.cmd, ssh.sshConnection);
        }
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save session on workspace changes (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      useWorkspaceStore.getState().saveSession();
    }, 500);
  }, [workspaces, activeId]);

  // Mirror the workspace list to the backend so the CLI (`wmux ls`) can read it
  // over the IPC pipe. The backend keeps no workspace state of its own.
  useEffect(() => {
    const summaries = workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      paneCount: collectLeafIds(ws.layout).length,
      active: ws.id === activeId,
    }));
    invoke("set_workspace_list", { workspaces: summaries }).catch(() => {});
  }, [workspaces, activeId]);

  // Confirm before closing, then save session (Tauri close-requested + beforeunload fallback)
  useEffect(() => {
    const appWindow = tryGetCurrentWindow();
    const unlistenPromise = appWindow?.onCloseRequested((event) => {
        if (closingRef.current) return;
        event.preventDefault();
        setCloseConfirmOpen(true);
      });

    const handleBeforeUnload = () => {
      logWarn("window beforeunload");
      useWorkspaceStore.getState().saveSession();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    const handleVisibility = () => {
      const store = useTmuxSessionsStore.getState();
      if (document.hidden) store.pauseAll();
      else store.resumeAll();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibility);
      unlistenPromise?.then((fn) => fn());
    };
  }, []);

  // Listen for PTY exit events to auto-close panes
  useEffect(() => {
    const unlisten = tauriPtyBackend.onExit((payload) => {
      const ptyId = payload.id;
      logWarn(`pty exit id=${ptyId} code=${payload.code ?? "none"}`);

      // Delay so "[Process exited]" message is visible
      setTimeout(() => {
        const state = useWorkspaceStore.getState();
        const match = findLeafByPtyId(state.workspaces, ptyId);
        if (!match) return;
        if (match.tmuxSession) return;

        const { workspaceId, leafId, leafCount } = match;

        if (leafCount > 1) {
          // Multiple panes: close just this pane
          destroyTerminal(leafId);
          useWorkspaceStore.getState().closeLeaf(workspaceId, leafId);
        } else {
          // Single pane: destroy terminal and replace workspace with fresh one
          destroyAllTerminals([leafId]);
          const store = useWorkspaceStore.getState();
          if (store.workspaces.length > 1) {
            store.removeWorkspace(workspaceId);
          } else {
            // Last workspace: replace it in-place with a new leaf
            store.resetWorkspace(workspaceId);
          }
        }
      }, 500);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for notification events from Rust backend
  useEffect(() => {
    const unlisten = listen<{
      title: string;
      body: string;
      workspace_id?: string;
      surface_id?: string;
      source?: string;
      event?: string;
    }>(
      "wmux-notify",
      (event) => {
        const { title, body } = event.payload;
        if (!shouldShowNotificationForTarget(event.payload.workspace_id, event.payload.surface_id)) {
          return;
        }

        const wsId = event.payload.workspace_id ?? activeId ?? "";
        const aiStatus = aiStatusFromHookNotification(
          event.payload.source,
          event.payload.event,
          body,
        );
        if (aiStatus && wsId) {
          useWorkspaceInfoStore.getState().patchInfo(wsId, {
            aiStatusLabel: aiStatus.label,
            aiStatusKind: aiStatus.kind,
            aiStatusUpdatedAt: aiStatus.updatedAt,
          });
        }
        const surfaceId = event.payload.surface_id;
        const taskStatus = agentTaskStatusFromEvent(event.payload.event, body);
        if (taskStatus && wsId && surfaceId) {
          useAgentTaskStore.getState().updateTask({
            workspaceId: wsId,
            surfaceId,
            source: event.payload.source ?? title,
            label: body || taskStatus,
            status: taskStatus,
            updatedAt: Date.now(),
          });
        }

        useNotificationStore.getState().addNotification(wsId, title, body);
        playNotificationSound();

        // Send Windows toast notification
        invoke("send_notification", { title, body }).catch(() => {});
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [activeId]);

  useEffect(() => {
    const unlisten = listen<ControlRequestEvent>("wmux-control-request", (event) => {
      void (async () => {
        let data: unknown = null;
        let error: string | null = null;
        try {
          data = await executeAppControlRequest(event.payload);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        await invoke("resolve_control_request", {
          requestId: event.payload.requestId,
          data,
          error,
        }).catch(() => {});
      })();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for agent hook session bindings from wmux-cli.
  useEffect(() => {
    const unlisten = listen<{
      source?: string;
      event?: string;
      workspace_id?: string;
      surface_id?: string;
      session_id?: string;
      cwd?: string;
      status?: string;
    }>(
      "wmux-agent-session",
      (event) => {
        const { source, workspace_id, surface_id, session_id } = event.payload;
        if (!isRestorableAgentKind(source) || !workspace_id || !surface_id || !session_id) {
          return;
        }

        const aiStatus = aiStatusFromAgentSessionEvent(
          source,
          event.payload.event,
          event.payload.status,
        );
        if (aiStatus) {
          useWorkspaceInfoStore.getState().patchInfo(workspace_id, {
            aiStatusLabel: aiStatus.label,
            aiStatusKind: aiStatus.kind,
            aiStatusUpdatedAt: aiStatus.updatedAt,
          });
        }
        const taskStatus = agentTaskStatusFromEvent(event.payload.event, event.payload.status);
        if (taskStatus) {
          useAgentTaskStore.getState().updateTask({
            workspaceId: workspace_id,
            surfaceId: surface_id,
            source,
            label: event.payload.status || taskStatus,
            status: taskStatus,
            updatedAt: Date.now(),
          });
        }

        if (isAgentSessionEndEvent(event.payload.event)) {
          useWorkspaceStore.getState().clearLeafAgentSession(workspace_id, surface_id, {
            kind: source,
            sessionId: session_id,
          });
          return;
        }

        useWorkspaceStore.getState().setLeafAgentSession(workspace_id, surface_id, {
          kind: source,
          sessionId: session_id,
          cwd: event.payload.cwd,
          event: event.payload.event,
          updatedAt: Date.now(),
        });
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Prefix mode timeouts (module-scoped via refs so handler closure stays stable)
  const prefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paneNumberTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keyboard shortcuts
  useEffect(() => {
    const activatePrefix = () => {
      usePrefixStore.getState().setActive(true);
      if (prefixTimeoutRef.current) clearTimeout(prefixTimeoutRef.current);
      prefixTimeoutRef.current = setTimeout(() => {
        usePrefixStore.getState().setActive(false);
        prefixTimeoutRef.current = null;
      }, PREFIX_TIMEOUT_MS);
    };

    const deactivatePrefix = () => {
      usePrefixStore.getState().setActive(false);
      if (prefixTimeoutRef.current) {
        clearTimeout(prefixTimeoutRef.current);
        prefixTimeoutRef.current = null;
      }
    };

    const triggerPaneNumbers = () => {
      usePrefixStore.getState().setShowPaneNumbers(true);
      if (paneNumberTimeoutRef.current) clearTimeout(paneNumberTimeoutRef.current);
      paneNumberTimeoutRef.current = setTimeout(() => {
        usePrefixStore.getState().setShowPaneNumbers(false);
        paneNumberTimeoutRef.current = null;
      }, PANE_NUMBER_TIMEOUT_MS);
    };

    const hidePaneNumbers = () => {
      usePrefixStore.getState().setShowPaneNumbers(false);
      if (paneNumberTimeoutRef.current) {
        clearTimeout(paneNumberTimeoutRef.current);
        paneNumberTimeoutRef.current = null;
      }
    };

    const switchWorkspaceDelta = (delta: number) => {
      const st = useWorkspaceStore.getState();
      const idx = st.workspaces.findIndex((w) => w.id === st.activeId);
      if (idx === -1 || st.workspaces.length < 2) return;
      const next = (idx + delta + st.workspaces.length) % st.workspaces.length;
      st.setActive(st.workspaces[next].id);
    };

    const selectWorkspaceByIndex = (i: number) => {
      const st = useWorkspaceStore.getState();
      if (st.workspaces[i]) st.setActive(st.workspaces[i].id);
    };

    const focusByPaneNumber = (i: number) => {
      const st = useWorkspaceStore.getState();
      const ws = st.workspaces.find((w) => w.id === st.activeId);
      if (!ws) return;
      const rects = collectRects(ws.layout);
      const target = rects[i];
      if (target) st.setFocusedLeaf(ws.id, target.id);
    };

    // Returns true if prefix mode should stay active (sticky) so the user
    // can chain the same command — e.g. arrow navigation — without re-pressing prefix.
    const dispatchPrefixCommand = (e: KeyboardEvent): boolean => {
      const st = useWorkspaceStore.getState();
      const ws = st.workspaces.find((w) => w.id === st.activeId);
      if (!ws) return false;

      // Directional focus / resize
      const arrowMap: Record<string, Direction> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };
      const dir = arrowMap[e.key];
      if (dir) {
        // Ctrl + arrow → resize (Shift is ignored so Ctrl+Shift+B prefix users
        // can keep Ctrl+Shift held and chain resize presses).
        if (e.ctrlKey) {
          const r = computeResize(ws.layout, ws.focusedLeafId, dir);
          if (r) st.setSplitRatio(ws.id, r.splitId, r.ratio);
        } else {
          const neighborId = findNeighbor(ws.layout, ws.focusedLeafId, dir);
          if (neighborId) st.setFocusedLeaf(ws.id, neighborId);
        }
        return true;
      }

      switch (e.key) {
        case " ":
        case "Spacebar":
          st.cycleLayout(ws.id);
          return false;
        case '"':
          st.splitLeaf(ws.id, ws.focusedLeafId, "vertical");
          return false;
        case "%":
          st.splitLeaf(ws.id, ws.focusedLeafId, "horizontal");
          return false;
        case "x": {
          const leaves = collectLeafIds(ws.layout);
          if (leaves.length > 1) {
            destroyTerminal(ws.focusedLeafId);
            st.closeLeaf(ws.id, ws.focusedLeafId);
          }
          return false;
        }
        case "z":
          st.toggleZoom(ws.id);
          return false;
        case "o": {
          const leaves = collectOrderedLeaves(ws.layout);
          if (leaves.length < 2) return false;
          const curIdx = leaves.findIndex((n) => n.id === ws.focusedLeafId);
          const next = leaves[(curIdx + 1) % leaves.length];
          st.setFocusedLeaf(ws.id, next.id);
          return false;
        }
        case "c":
          st.addWorkspace();
          return false;
        case "n":
          switchWorkspaceDelta(1);
          return false;
        case "p":
          switchWorkspaceDelta(-1);
          return false;
        case "q":
          triggerPaneNumbers();
          return false;
        case "{":
          st.swapPane(ws.id, "prev");
          return true;
        case "}":
          st.swapPane(ws.id, "next");
          return true;
        case "!":
          st.breakPane(ws.id, ws.focusedLeafId);
          return false;
        case "h":
          usePrefixStore.getState().setHistoryOpen(true);
          return false;
      }

      if (/^[0-9]$/.test(e.key)) {
        selectWorkspaceByIndex(parseInt(e.key, 10));
        return false;
      }
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTerminalCompositionKeyEvent(e)) return;

      const prefixActive = usePrefixStore.getState().active;
      const paneNumbersVisible = usePrefixStore.getState().showPaneNumbers;
      const historyOpen = usePrefixStore.getState().historyOpen;
      const prefKey = useSettingsStore.getState().prefixKey;

      // History panel owns keyboard input while open
      if (historyOpen) return;

      // Pane-number pick mode: digit picks pane, any other key cancels overlay
      if (paneNumbersVisible && !prefixActive) {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          focusByPaneNumber(parseInt(e.key, 10));
          hidePaneNumbers();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          hidePaneNumbers();
          return;
        }
      }

      // Prefix activation
      if (!prefixActive && matchesPrefixKey(e, prefKey)) {
        e.preventDefault();
        e.stopPropagation();
        activatePrefix();
        return;
      }

      // Prefix command dispatch
      if (prefixActive) {
        // Ignore plain modifier keydown events (Ctrl, Shift, Alt) — wait for real key
        if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") { deactivatePrefix(); return; }
        const keepActive = dispatchPrefixCommand(e);
        if (keepActive) {
          activatePrefix(); // refresh timeout so arrows can be chained
        } else {
          deactivatePrefix();
        }
        return;
      }

      if (!activeWs) return;

      const shortcut = decideAppShortcut(e, APP_SHORTCUT_PLATFORM);
      if (shortcut.kind !== "none") {
        e.preventDefault();
        switch (shortcut.kind) {
          case "toggleGrid":
            setGridView((prev) => !prev);
            return;
          case "splitHorizontal":
            splitLeaf(activeWs.id, activeWs.focusedLeafId, "horizontal");
            return;
          case "splitVertical":
            splitLeaf(activeWs.id, activeWs.focusedLeafId, "vertical");
            return;
          case "openBrowser":
            openBrowser(activeWs.id, activeWs.focusedLeafId, "http://localhost:3000");
            return;
          case "closePane": {
            const leaves = collectLeafIds(activeWs.layout);
            if (leaves.length > 1) {
              destroyTerminal(activeWs.focusedLeafId);
              closeLeaf(activeWs.id, activeWs.focusedLeafId);
            }
            return;
          }
          case "newWorkspace":
            addWorkspace();
            return;
          case "closeWorkspace":
            if (workspaces.length > 1) {
              const leaves = collectLeafIds(activeWs.layout);
              destroyAllTerminals(leaves);
              removeWorkspace(activeWs.id);
            }
            return;
          case "toggleNotifications":
            useNotificationStore.getState().togglePanel();
            return;
          case "toggleSettings":
            setSettingsOpen((prev) => !prev);
            return;
          case "increaseFontSize":
            useSettingsStore.getState().increaseFontSize();
            return;
          case "decreaseFontSize":
            useSettingsStore.getState().decreaseFontSize();
            return;
          case "resetFontSize":
            useSettingsStore.getState().setFontSize(14);
            return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeWs, workspaces, addWorkspace, removeWorkspace, splitLeaf, closeLeaf, openBrowser, gridView]);

  const handleConnectHost = useCallback(async (host: SshHost) => {
    const sshConnection = buildSshConnection(host);
    const cmd = buildSshCommand(host);
    const target = `${host.user}@${host.host}`;
    const mode = host.persistMode ?? "auto";

    // Decide tmux wrapping policy. For "auto", probe the remote for tmux 3.2+
    // before opening the workspace so the first spawn already uses tmux-CC.
    let useTmux = mode === "on";
    if (mode === "auto") {
      try {
        const version = await invoke<string | null>("check_remote_tmux", { sshCommand: cmd, sshConnection });
        useTmux = !!version && isTmuxVersionSupported(version);
      } catch {
        useTmux = false;
      }
    }
    const tmuxSession = useTmux ? sanitizeTmuxSessionName(`wmux-${host.host}`) : undefined;

    const wsId = addWorkspace(host.name, cmd, tmuxSession, sshConnection);
    if (tmuxSession) {
      useTmuxSessionsStore.getState().attach(wsId, cmd, tmuxSession, sshConnection);
    }
    const monitorId = `mon-${Date.now()}`;
    setSidebarMonitor((prev) => {
      if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
      return { monitorId, sshTarget: target, sshCommand: cmd, sshConnection };
    });
    monitorTargetRef.current = target;
    monitorCommandRef.current = cmd;

    autoAiSplit(wsId, cmd, sshConnection, host);
  }, [addWorkspace]);

  const handleViewClaudeSession = useCallback((sshTarget: string, project: string, projectPath: string | undefined, sessionId: string, sshConnection?: SshConnection) => {
    if (!activeWs || !sidebarMonitor) return;
    useWorkspaceStore.getState().openClaudeSession(activeWs.id, activeWs.focusedLeafId, sshTarget, project, projectPath, sessionId, sidebarMonitor.monitorId, sshConnection);
  }, [activeWs, sidebarMonitor]);

  const handleResumeClaudeSession = useCallback((sshCommand: string, projectPath: string, sessionId: string, sshConnection?: SshConnection) => {
    const remote = `cd ${quotePosixShellArg(projectPath)} && claude --resume ${quotePosixShellArg(sessionId)}`;
    const connection = sshConnection ?? parseSshCommandLine(sshCommand)?.connection;
    const cmd = connection
      ? buildSshCommandWithRemoteCmdFromConnection(connection, remote, true)
      : buildSshCommandWithRemoteCmdFromBase(sshCommand, remote, true);
    addWorkspace(`Claude: ${projectPath.split("/").pop()}`, cmd, undefined, connection, remote);
  }, [addWorkspace]);

  const handleCloseMonitor = useCallback(() => {
    if (sidebarMonitor) {
      invoke("stop_monitor", { monitorId: sidebarMonitor.monitorId }).catch(() => {});
      setSidebarMonitor(null);
      monitorTargetRef.current = null;
    }
  }, [sidebarMonitor]);

  const handleWindowMinimize = useCallback(() => {
    tryGetCurrentWindow()?.minimize().catch((err) => console.error("[wmux] minimize failed:", err));
  }, []);

  const handleWindowMaximize = useCallback(() => {
    tryGetCurrentWindow()?.toggleMaximize().catch((err) => console.error("[wmux] toggleMaximize failed:", err));
  }, []);

  const handleWindowClose = useCallback(() => {
    logInfo("window close requested");
    tryGetCurrentWindow()?.close().catch((err) => console.error("[wmux] close failed:", err));
  }, []);

  const handleCloseConfirm = useCallback(async () => {
    closingRef.current = true;
    setCloseConfirmOpen(false);
    logInfo("window close confirmed");
    useWorkspaceStore.getState().saveSession();
    try {
      await tryGetCurrentWindow()?.destroy();
    } catch (err) {
      console.error("[wmux] destroy failed:", err);
      closingRef.current = false;
    }
  }, []);

  return (
    <div style={styles.container}>
      {dashboardLayout === "left" ? (
        <div data-tauri-drag-region style={styles.titlebar}>
          <div data-tauri-drag-region style={styles.titlebarBrand}>
            <span data-tauri-drag-region style={styles.titlebarLogo}>wmux</span>
            <span data-tauri-drag-region style={styles.titlebarSubtitle}>
              {activeWs?.name ?? "Terminal Multiplexer"}
            </span>
          </div>
          <WindowControls
            onMinimize={handleWindowMinimize}
            onMaximize={handleWindowMaximize}
            onClose={handleWindowClose}
          />
        </div>
      ) : (
        <TopDashboardBar
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSshPanel={() => { setSshPanelEditId(null); setSshPanelOpen(true); }}
          onEditHost={(hostId) => { setSshPanelEditId(hostId); setSshPanelOpen(true); }}
          onConnectHost={handleConnectHost}
          monitor={sidebarMonitor}
          onCloseMonitor={handleCloseMonitor}
          onWindowMinimize={handleWindowMinimize}
          onWindowMaximize={handleWindowMaximize}
          onWindowClose={handleWindowClose}
          gridView={gridView}
          onToggleGridView={() => setGridView((prev) => !prev)}
          filesRailVisible={filesRailVisible}
          onToggleFilesRail={() => setFilesRailVisible((prev) => !prev)}
        />
      )}
      <div style={styles.appBody}>
        {dashboardLayout === "left" ? (
          <Sidebar
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenSshPanel={() => { setSshPanelEditId(null); setSshPanelOpen(true); }}
            onEditHost={(hostId) => { setSshPanelEditId(hostId); setSshPanelOpen(true); }}
            onConnectHost={handleConnectHost}
            monitor={sidebarMonitor}
            onCloseMonitor={handleCloseMonitor}
            onViewClaudeSession={handleViewClaudeSession}
            onResumeClaudeSession={handleResumeClaudeSession}
            gridView={gridView}
            onToggleGridView={() => setGridView((prev) => !prev)}
          />
        ) : filesRailVisible ? (
          <FilesRail
            cwd={fileRailCwd}
            sshConnection={fileRailSshConnection}
            sshCommand={fileRailSshCommand}
          />
        ) : null}
        <div style={styles.terminalArea}>
          {gridView ? (
            <GridOverview
              workspaces={workspaces}
              activeId={activeId}
            />
          ) : activeWs ? (
            <>
              <SplitPane
                node={
                  activeWs.zoomedLeafId
                    ? collectOrderedLeaves(activeWs.layout).find((n) => n.id === activeWs.zoomedLeafId) ?? activeWs.layout
                    : activeWs.layout
                }
                workspaceId={activeWs.id}
                browserVisible={browserVisible}
              />
              <PaneNumberOverlay workspaceId={activeWs.id} />
            </>
          ) : (
            <div style={styles.welcome}>
              <div style={styles.welcomeLogo}>wmux</div>
              <div style={styles.welcomeTagline}>Terminal Multiplexer</div>
              <div style={styles.welcomeHints}>
                <span><b>Ctrl+Shift+T</b> New session</span>
                <span><b>Ctrl+Shift+D</b> Split horizontal</span>
                <span><b>Ctrl+Shift+E</b> Split vertical</span>
                <span><b>Ctrl+Shift+G</b> Grid overview</span>
                <span><b>H</b> button to manage SSH hosts</span>
              </div>
            </div>
          )}
        </div>
        <PrefixIndicator />
        <HistoryPanel />
        <NotificationPanel />
        <LaunchProfilesPanel
          open={launchProfilesOpen}
          onClose={() => setLaunchProfilesOpen(false)}
        />
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <SshHostPanel
          open={sshPanelOpen}
          editHostId={sshPanelEditId}
          onClose={() => { setSshPanelEditId(null); setSshPanelOpen(false); }}
          onConnect={(host) => { handleConnectHost(host); setSshPanelEditId(null); setSshPanelOpen(false); }}
        />
        <ConfirmDialog
          open={closeConfirmOpen}
          message="wmux를 닫을까요?"
          confirmLabel="닫기"
          cancelLabel="취소"
          destructive
          onConfirm={handleCloseConfirm}
          onCancel={() => setCloseConfirmOpen(false)}
        />
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: "var(--wmux-bg)",
  },
  titlebar: {
    height: 36,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "var(--wmux-titlebar-bg)",
    color: "var(--wmux-text)",
    userSelect: "none" as const,
  },
  titlebarBrand: {
    minWidth: 0,
    flex: 1,
    height: "100%",
    display: "flex",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
  },
  titlebarLogo: {
    color: "var(--wmux-accent)",
    fontFamily: "var(--wmux-font-display)",
    fontSize: 13,
    fontWeight: 800,
    lineHeight: 1,
  },
  titlebarSubtitle: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    color: "var(--wmux-subtext)",
    fontSize: 12,
    lineHeight: 1,
  },
  appBody: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    overflow: "hidden",
  },
  terminalArea: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  welcome: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: 16,
    color: "var(--wmux-subtext)",
    fontFamily: "var(--wmux-font-display)",
    userSelect: "none" as const,
  },
  welcomeLogo: {
    fontSize: 48,
    fontWeight: 800,
    color: "var(--wmux-accent)",
    letterSpacing: 0,
  },
  welcomeTagline: {
    fontSize: 14,
    color: "var(--wmux-subtext)",
  },
  welcomeHints: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    fontSize: 12,
    color: "var(--wmux-subtext)",
    opacity: 0.75,
    marginTop: 16,
  },
};
