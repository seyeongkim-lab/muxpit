import { useEffect, useState, useRef, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { SplitPane } from "./components/SplitPane";
import { NotificationPanel } from "./components/NotificationPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SshHostPanel } from "./components/SshHostPanel";
import { useWorkspaceStore, collectLeafIds, findLeafByPtyId } from "./stores/workspace";
import { buildSshCommand, type SshHost } from "./stores/sshHosts";
import { useNotificationStore } from "./stores/notifications";
import { useSettingsStore } from "./stores/settings";
import { destroyTerminal, destroyAllTerminals } from "./components/Terminal";
import { useWorkspaceInfoPoller, useSshContextPoller } from "./hooks/useWorkspaceInfo";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { LayoutNode, LeafNode } from "./stores/workspace";

const findLeafNode = (node: LayoutNode, id: string): LeafNode | null => {
  if (node.type === "leaf") return node.id === id ? node : null;
  if (node.type === "split") return findLeafNode(node.children[0], id) ?? findLeafNode(node.children[1], id);
  return null;
};

// Parse "user@host" from SSH command like: ssh user@host -t bash, "C:\...\ssh.exe" user@host
const parseSshTarget = (cmd: string): string | null => {
  const parts = cmd.split(/\s+/);
  for (const part of parts) {
    // Skip flags, quoted paths, and the ssh binary itself
    if (part.startsWith("-") || part.startsWith('"') || part.toLowerCase().includes("ssh")) continue;
    if (part.includes("@")) return part;
  }
  // Fallback: look for user@host pattern anywhere
  const match = cmd.match(/(\S+@\S+)/);
  return match ? match[1] : null;
};

export const App = () => {
  const { workspaces, activeId, addWorkspace, removeWorkspace, splitLeaf, closeLeaf, openBrowser } =
    useWorkspaceStore();
  const activeWs = workspaces.find((w) => w.id === activeId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sshPanelOpen, setSshPanelOpen] = useState(false);
  const [sidebarMonitor, setSidebarMonitor] = useState<{ monitorId: string; sshTarget: string } | null>(null);

  const uiFontSize = useSettingsStore((s) => s.fontSize);

  // Scale entire UI based on font size
  useEffect(() => {
    document.documentElement.style.fontSize = `${uiFontSize}px`;
  }, [uiFontSize]);

  // Poll workspace metadata (git, ports) every 5 seconds
  useWorkspaceInfoPoller(5000);
  // SSH context caching every 30 seconds (for session restore)
  useSshContextPoller(30000);

  // Auto-detect SSH on focused pane and show sidebar monitor (poll every 5s)
  const monitorTargetRef = useRef<string | null>(null);
  const focusedLeafId = activeWs?.focusedLeafId;
  const activeWsId = activeWs?.id;

  useEffect(() => {
    if (!activeWsId || !focusedLeafId) return;
    let cancelled = false;

    const checkSsh = async () => {
      const state = useWorkspaceStore.getState();
      const ws = state.workspaces.find((w) => w.id === activeWsId);
      if (!ws) return;
      const leaf = findLeafNode(ws.layout, focusedLeafId);
      if (!leaf || leaf.type !== "leaf" || !leaf.ptyId) {
        if (monitorTargetRef.current) {
          monitorTargetRef.current = null;
          setSidebarMonitor((prev) => {
            if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
            return null;
          });
        }
        return;
      }

      let target: string | null = null;

      // Check leaf.command first (set when connecting via SSH host registry)
      if (leaf.command && leaf.command.toLowerCase().includes("ssh")) {
        target = parseSshTarget(leaf.command);
      }
      // Fallback: live SSH process detection (for manually typed ssh commands)
      if (!target) {
        try {
          const ctx = await invoke<{ ssh_command: string | null }>("get_shell_ctx", { id: leaf.ptyId });
          if (ctx.ssh_command) target = parseSshTarget(ctx.ssh_command);
        } catch {}
      }

      if (cancelled) return;

      if (target && target !== monitorTargetRef.current) {
        monitorTargetRef.current = target;
        setSidebarMonitor((prev) => {
          if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
          return { monitorId: `mon-${Date.now()}`, sshTarget: target! };
        });
      } else if (!target && monitorTargetRef.current) {
        monitorTargetRef.current = null;
        setSidebarMonitor((prev) => {
          if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
          return null;
        });
      }
    };

    checkSsh();
    const timer = setInterval(checkSsh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeWsId, focusedLeafId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore session or create initial workspace
  useEffect(() => {
    const restored = useWorkspaceStore.getState().restoreSession();
    if (!restored && workspaces.length === 0) {
      addWorkspace("Shell 1");
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

  // Save session on window close (Tauri close-requested + beforeunload fallback)
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlistenPromise = appWindow.onCloseRequested(async () => {
      useWorkspaceStore.getState().saveSession();
      await appWindow.destroy();
    });

    const handleBeforeUnload = () => {
      useWorkspaceStore.getState().saveSession();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!activeWs) return;

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
  }, [activeWs, workspaces, addWorkspace, removeWorkspace, splitLeaf, closeLeaf, openBrowser]);

  const handleConnectHost = useCallback((host: SshHost) => {
    const cmd = buildSshCommand(host);
    addWorkspace(host.name, cmd);
    // Start monitor immediately — no need to wait for SSH auto-detection
    const target = `${host.user}@${host.host}`;
    const monitorId = `mon-${Date.now()}`;
    setSidebarMonitor((prev) => {
      if (prev) invoke("stop_monitor", { monitorId: prev.monitorId }).catch(() => {});
      return { monitorId, sshTarget: target };
    });
    monitorTargetRef.current = target;
  }, [addWorkspace]);

  const handleCloseMonitor = useCallback(() => {
    if (sidebarMonitor) {
      invoke("stop_monitor", { monitorId: sidebarMonitor.monitorId }).catch(() => {});
      setSidebarMonitor(null);
    }
  }, [sidebarMonitor]);

  return (
    <div style={styles.container}>
      <Sidebar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSshPanel={() => setSshPanelOpen(true)}
        onConnectHost={handleConnectHost}
        monitor={sidebarMonitor}
        onCloseMonitor={handleCloseMonitor}
      />
      <div style={styles.terminalArea}>
        {activeWs ? (
          <SplitPane node={activeWs.layout} workspaceId={activeWs.id} />
        ) : (
          <div style={styles.welcome}>
            <div style={styles.welcomeLogo}>wmux</div>
            <div style={styles.welcomeTagline}>Terminal Multiplexer for Windows</div>
            <div style={styles.welcomeHints}>
              <span><b>Ctrl+Shift+T</b> New session</span>
              <span><b>Ctrl+Shift+D</b> Split horizontal</span>
              <span><b>Ctrl+Shift+E</b> Split vertical</span>
              <span><b>H</b> button to manage SSH hosts</span>
            </div>
          </div>
        )}
      </div>
      <NotificationPanel />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SshHostPanel
        open={sshPanelOpen}
        onClose={() => setSshPanelOpen(false)}
        onConnect={(host) => { handleConnectHost(host); setSshPanelOpen(false); }}
      />
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    width: "100%",
    height: "100%",
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
    fontWeight: 700,
    color: "#89b4fa",
    letterSpacing: -2,
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
