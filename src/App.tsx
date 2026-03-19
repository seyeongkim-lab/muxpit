import { useEffect, useState, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { SplitPane } from "./components/SplitPane";
import { NotificationPanel } from "./components/NotificationPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { useWorkspaceStore, collectLeafIds, findLeafByPtyId } from "./stores/workspace";
import { useNotificationStore } from "./stores/notifications";
import { useSettingsStore } from "./stores/settings";
import { destroyTerminal, destroyAllTerminals } from "./components/Terminal";
import { useWorkspaceInfoPoller, useSshContextPoller } from "./hooks/useWorkspaceInfo";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const App = () => {
  const { workspaces, activeId, addWorkspace, removeWorkspace, splitLeaf, closeLeaf, openBrowser } =
    useWorkspaceStore();
  const activeWs = workspaces.find((w) => w.id === activeId);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const uiFontSize = useSettingsStore((s) => s.fontSize);

  // Scale entire UI based on font size
  useEffect(() => {
    document.documentElement.style.fontSize = `${uiFontSize}px`;
  }, [uiFontSize]);

  // Poll workspace metadata (git, ports) every 5 seconds
  useWorkspaceInfoPoller(5000);
  // SSH context caching every 30 seconds (for session restore)
  useSshContextPoller(30000);

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

  return (
    <div style={styles.container}>
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      <div style={styles.terminalArea}>
        {activeWs && (
          <SplitPane node={activeWs.layout} workspaceId={activeWs.id} />
        )}
      </div>
      <NotificationPanel />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
};
