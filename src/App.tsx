import { useEffect, useState, useRef, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { SplitPane } from "./components/SplitPane";
import { GridOverview } from "./components/GridOverview";
import { NotificationPanel } from "./components/NotificationPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SshHostPanel } from "./components/SshHostPanel";
import { PrefixIndicator } from "./components/PrefixIndicator";
import { PaneNumberOverlay } from "./components/PaneNumberOverlay";
import { HistoryPanel } from "./components/HistoryPanel";
import { useWorkspaceStore, collectLeafIds, findLeafByPtyId } from "./stores/workspace";
import { buildSshCommand, type SshHost } from "./stores/sshHosts";
import { useAiCliStore, buildAiLaunchCommand, parseSshTarget } from "./stores/aiCli";
import { useNotificationStore } from "./stores/notifications";
import { useTmuxSessionsStore } from "./stores/tmuxSessions";
import { useSettingsStore } from "./stores/settings";
import { usePrefixStore, PREFIX_TIMEOUT_MS, PANE_NUMBER_TIMEOUT_MS } from "./stores/prefix";
import { destroyTerminal, destroyAllTerminals } from "./components/terminalRegistry";
import { useWorkspaceInfoPoller, useSshContextPoller } from "./hooks/useWorkspaceInfo";
import { applyThemeVars, getResolvedTheme } from "./themes";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { LayoutNode, LeafNode } from "./stores/workspace";
import {
  findNeighbor,
  computeResize,
  collectOrderedLeaves,
  collectRects,
  type Direction,
} from "./utils/layoutGeometry";
import { matchesPrefixKey } from "./utils/prefixKey";
import { sanitizeTmuxSessionName } from "./utils/tmuxSession";

const findLeafNode = (node: LayoutNode, id: string): LeafNode | null => {
  if (node.type === "leaf") return node.id === id ? node : null;
  if (node.type === "split") return findLeafNode(node.children[0], id) ?? findLeafNode(node.children[1], id);
  return null;
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
const autoAiSplit = async (wsId: string, sshCommand: string, host?: SshHost) => {
  try {
    const target = host ? `${host.user}@${host.host}` : parseSshTarget(sshCommand);
    if (!target) return;

    await useAiCliStore.getState().probe(target, sshCommand);
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
        return /(?:^|['" /])(claude|codex|gemini|copilot)\b/.test(node.command ?? "");
      }
      if (node.type === "split") return hasAiPane(node.children[0]) || hasAiPane(node.children[1]);
      return false;
    };
    if (hasAiPane(ws.layout)) return;

    const claudeCmd = buildAiLaunchCommand("claude", sshCommand, host);
    const leafId = ws.layout.type === "leaf" ? ws.layout.id : ws.focusedLeafId;
    useWorkspaceStore.getState().splitLeafWithCommand(wsId, leafId, "horizontal", claudeCmd, {
      aiKind: "claude",
      aiSshTarget: target,
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
  const [sidebarMonitor, setSidebarMonitor] = useState<{ monitorId: string; sshTarget: string } | null>(null);

  const uiFontSize = useSettingsStore((s) => s.fontSize);
  const themeName = useSettingsStore((s) => s.themeName);
  const customColors = useSettingsStore((s) => s.customColors);

  // Push resolved theme colours onto :root as CSS custom properties so the
  // sidebar/toolbar chrome stays in sync when the user switches themes.
  useEffect(() => {
    applyThemeVars(getResolvedTheme(themeName, customColors));
  }, [themeName, customColors]);

  // Use Tauri's webview page-zoom (same mechanism as Ctrl+mouse-wheel in a browser).
  // The CSS `zoom` property scales pixels after layout, so DOM APIs like clientWidth
  // still return the pre-zoom size — xterm's fitAddon then picked too few cols/rows and
  // left top/right gaps. Page zoom, by contrast, scales the viewport itself so all
  // measurements stay consistent. Baseline: fontSize=14 → zoom=1.0.
  useEffect(() => {
    getCurrentWebview()
      .setZoom(uiFontSize / 14)
      .catch((err) => console.error("[wmux] setZoom failed:", err));
  }, [uiFontSize]);

  // Poll workspace metadata (git, ports) every 5 seconds
  useWorkspaceInfoPoller(5000);
  // SSH context caching every 30 seconds (for session restore)
  useSshContextPoller(30000);

  // Auto-detect SSH on focused pane and show sidebar monitor (poll every 5s)
  const monitorTargetRef = useRef<string | null>(null);
  const activeWsId = activeWs?.id;

  useEffect(() => {
    if (!activeWsId) {
      // No active workspace — stop monitor
      monitorTargetRef.current = null;
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

        if (leaf.command && leaf.command.toLowerCase().includes("ssh")) {
          target = parseSshTarget(leaf.command);
        }

        if (!target) {
          try {
            const ctx = await invoke<{ ssh_command: string | null }>("get_shell_ctx", { id: leaf.ptyId });
            if (!cancelled && ctx.ssh_command) target = parseSshTarget(ctx.ssh_command);
          } catch {}
        }

        if (cancelled) return;

        if (target) {
          if (target !== monitorTargetRef.current) {
            monitorTargetRef.current = target;
            setSidebarMonitor((prev) => {
              if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
              return { monitorId: `mon-${Date.now()}`, sshTarget: target! };
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

    // Auto claude split for restored SSH workspaces
    if (restored) {
      const state = useWorkspaceStore.getState();
      for (const ws of state.workspaces) {
        // Find first SSH leaf in the layout tree
        const findSshLeaf = (node: LayoutNode): string | null => {
          if (node.type === "leaf") return node.command?.toLowerCase().includes("ssh") ? node.command : null;
          if (node.type === "split") return findSshLeaf(node.children[0]) ?? findSshLeaf(node.children[1]);
          return null;
        };
        const sshCmd = findSshLeaf(ws.layout);
        if (sshCmd) {
          autoAiSplit(ws.id, sshCmd);
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

  // Confirm before closing, then save session (Tauri close-requested + beforeunload fallback)
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let promptOpen = false;
    let closing = false;
    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (promptOpen || closing) return;

      promptOpen = true;
      const confirmed = window.confirm("wmux를 닫을까요?");
      promptOpen = false;
      if (!confirmed) return;

      closing = true;
      useWorkspaceStore.getState().saveSession();
      await appWindow.destroy();
    });

    const handleBeforeUnload = () => {
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
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // Listen for PTY exit events to auto-close panes
  useEffect(() => {
    const unlisten = listen<{ id: number; code: number | null }>(
      "pty-exit",
      (event) => {
        const ptyId = event.payload.id;

        // Delay so "[Process exited]" message is visible
        setTimeout(() => {
          const state = useWorkspaceStore.getState();
          const match = findLeafByPtyId(state.workspaces, ptyId);
          if (!match) return;

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
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for notification events from Rust backend
  useEffect(() => {
    const unlisten = listen<{ title: string; body: string; workspace_id?: string }>(
      "wmux-notify",
      (event) => {
        const { title, body } = event.payload;
        const wsId = event.payload.workspace_id ?? activeId ?? "";
        useNotificationStore.getState().addNotification(wsId, title, body);

        // Send Windows toast notification
        invoke("send_notification", { title, body }).catch(() => {});
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [activeId]);

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

      // Ctrl+Shift+G: toggle grid / single view mode
      if (e.ctrlKey && e.shiftKey && e.key === "G") {
        e.preventDefault();
        setGridView((prev) => !prev);
        return;
      }

      // Ctrl+Shift+D: split vertical
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        splitLeaf(activeWs.id, activeWs.focusedLeafId, "horizontal");
      }
      // Ctrl+Shift+E: split horizontal
      if (e.ctrlKey && e.shiftKey && e.key === "E") {
        e.preventDefault();
        splitLeaf(activeWs.id, activeWs.focusedLeafId, "vertical");
      }
      // Ctrl+Shift+B: open browser pane
      if (e.ctrlKey && e.shiftKey && e.key === "B") {
        e.preventDefault();
        openBrowser(activeWs.id, activeWs.focusedLeafId, "http://localhost:3000");
      }
      // Ctrl+Shift+W: close focused pane
      if (e.ctrlKey && e.shiftKey && e.key === "W") {
        e.preventDefault();
        const leaves = collectLeafIds(activeWs.layout);
        if (leaves.length > 1) {
          destroyTerminal(activeWs.focusedLeafId);
          closeLeaf(activeWs.id, activeWs.focusedLeafId);
        }
      }
      // Ctrl+Shift+T: new workspace
      if (e.ctrlKey && e.shiftKey && e.key === "T") {
        e.preventDefault();
        addWorkspace();
      }
      // Ctrl+Shift+X: close workspace
      if (e.ctrlKey && e.shiftKey && e.key === "X") {
        e.preventDefault();
        if (workspaces.length > 1) {
          const leaves = collectLeafIds(activeWs.layout);
          destroyAllTerminals(leaves);
          removeWorkspace(activeWs.id);
        }
      }
      // Ctrl+Shift+I: toggle notification panel
      if (e.ctrlKey && e.shiftKey && e.key === "I") {
        e.preventDefault();
        useNotificationStore.getState().togglePanel();
      }
      // Ctrl+,: toggle settings panel
      if (e.ctrlKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      }
      // Ctrl+=: increase font size
      if (e.ctrlKey && !e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        useSettingsStore.getState().increaseFontSize();
      }
      // Ctrl+-: decrease font size
      if (e.ctrlKey && !e.shiftKey && e.key === "-") {
        e.preventDefault();
        useSettingsStore.getState().decreaseFontSize();
      }
      // Ctrl+0: reset font size
      if (e.ctrlKey && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        useSettingsStore.getState().setFontSize(14);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeWs, workspaces, addWorkspace, removeWorkspace, splitLeaf, closeLeaf, openBrowser, gridView]);

  const handleConnectHost = useCallback(async (host: SshHost) => {
    const cmd = buildSshCommand(host);
    const target = `${host.user}@${host.host}`;
    const mode = host.persistMode ?? "auto";

    // Decide tmux wrapping policy. For "auto", probe the remote for tmux 3.2+
    // before opening the workspace so the first spawn already uses tmux-CC.
    let useTmux = mode === "on";
    if (mode === "auto") {
      try {
        const version = await invoke<string | null>("check_remote_tmux", { sshCommand: cmd });
        useTmux = !!version && isTmuxVersionSupported(version);
      } catch {
        useTmux = false;
      }
    }
    const tmuxSession = useTmux ? sanitizeTmuxSessionName(`wmux-${host.host}`) : undefined;

    const wsId = addWorkspace(host.name, cmd, tmuxSession);
    if (tmuxSession) {
      useTmuxSessionsStore.getState().attach(wsId, cmd, tmuxSession);
    }
    const monitorId = `mon-${Date.now()}`;
    setSidebarMonitor((prev) => {
      if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
      return { monitorId, sshTarget: target };
    });
    monitorTargetRef.current = target;

    autoAiSplit(wsId, cmd, host);
  }, [addWorkspace]);

  const handleViewClaudeSession = useCallback((sshTarget: string, project: string, sessionId: string) => {
    if (!activeWs || !sidebarMonitor) return;
    useWorkspaceStore.getState().openClaudeSession(activeWs.id, activeWs.focusedLeafId, sshTarget, project, sessionId, sidebarMonitor.monitorId);
  }, [activeWs, sidebarMonitor]);

  const handleResumeClaudeSession = useCallback((sshTarget: string, projectPath: string, sessionId: string) => {
    const cmd = `ssh -t ${sshTarget} "cd ${projectPath} && claude --resume ${sessionId}"`;
    addWorkspace(`Claude: ${projectPath.split("/").pop()}`, cmd);
  }, [addWorkspace]);

  const handleCloseMonitor = useCallback(() => {
    if (sidebarMonitor) {
      invoke("stop_monitor", { monitorId: sidebarMonitor.monitorId }).catch(() => {});
      setSidebarMonitor(null);
      monitorTargetRef.current = null;
    }
  }, [sidebarMonitor]);

  const handleWindowMinimize = useCallback(() => {
    getCurrentWindow().minimize().catch((err) => console.error("[wmux] minimize failed:", err));
  }, []);

  const handleWindowMaximize = useCallback(() => {
    getCurrentWindow().toggleMaximize().catch((err) => console.error("[wmux] toggleMaximize failed:", err));
  }, []);

  const handleWindowClose = useCallback(() => {
    getCurrentWindow().close().catch((err) => console.error("[wmux] close failed:", err));
  }, []);

  return (
    <div style={styles.container}>
      <div data-tauri-drag-region style={styles.titlebar} onDoubleClick={handleWindowMaximize}>
        <div data-tauri-drag-region style={styles.titlebarBrand}>
          <span data-tauri-drag-region style={styles.titlebarLogo}>wmux</span>
          <span data-tauri-drag-region style={styles.titlebarSubtitle}>
            {activeWs?.name ?? "Terminal Multiplexer"}
          </span>
        </div>
        <div style={styles.titlebarControls} onDoubleClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="wmux-titlebar-btn"
            style={styles.titlebarButton}
            onClick={handleWindowMinimize}
            title="Minimize"
          >
            -
          </button>
          <button
            type="button"
            className="wmux-titlebar-btn"
            style={styles.titlebarButton}
            onClick={handleWindowMaximize}
            title="Maximize"
          >
            □
          </button>
          <button
            type="button"
            className="wmux-titlebar-btn wmux-titlebar-close"
            style={{ ...styles.titlebarButton, ...styles.titlebarCloseButton }}
            onClick={handleWindowClose}
            title="Close"
          >
            ×
          </button>
        </div>
      </div>
      <div style={styles.appBody}>
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
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <SshHostPanel
          open={sshPanelOpen}
          editHostId={sshPanelEditId}
          onClose={() => { setSshPanelEditId(null); setSshPanelOpen(false); }}
          onConnect={(host) => { handleConnectHost(host); setSshPanelEditId(null); setSshPanelOpen(false); }}
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
    height: 32,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "var(--wmux-bg)",
    borderBottom: "1px solid var(--wmux-hairline)",
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
  titlebarControls: {
    height: "100%",
    display: "flex",
    flexShrink: 0,
  },
  titlebarButton: {
    width: 42,
    height: "100%",
    border: "none",
    borderLeft: "1px solid transparent",
    backgroundColor: "transparent",
    color: "var(--wmux-subtext)",
    fontSize: 13,
    lineHeight: 1,
    cursor: "default",
  },
  titlebarCloseButton: {
    fontSize: 16,
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
    color: "#585b70",
    fontFamily: "'JetBrains Mono', monospace",
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
    color: "#a6adc8",
  },
  welcomeHints: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    fontSize: 12,
    color: "#585b70",
    marginTop: 16,
  },
};
