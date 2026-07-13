import { terminalInstances } from "../components/terminalRegistry";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { useWorkspaceStore } from "../stores/workspace";
import { buildAiRemoteCommand } from "./aiRemoteCommand";
import { detectRestorableAgentCommand } from "./agentSession";
import { findTerminalLeaf } from "./terminalSessionLayout";
import {
  buildSshCommandWithRemoteCmdFromConnection,
  parseSshCommandLine,
} from "./sshConnection";
import {
  executeControlRequest,
  type ControlRequestEvent,
  type ControlRuntime,
} from "./controlRequest";
import { tauriPtyBackend } from "./tauriPtyBackend";
import { browserWebviewLabel, normalizeBrowserUrl } from "./browserWebview";

const runtime: ControlRuntime = {
  getWorkspaces: () => {
    const state = useWorkspaceStore.getState();
    return { workspaces: state.workspaces, activeId: state.activeId };
  },
  getLeafCwd: (workspaceId, surfaceId) => {
    const state = useWorkspaceInfoStore.getState();
    return state.leafCwds[workspaceId]?.[surfaceId] ?? state.info[workspaceId]?.cwd;
  },
  split: (workspaceId, surfaceId, direction, command, metadata) => {
    const state = useWorkspaceStore.getState();
    if (!command) return state.splitLeaf(workspaceId, surfaceId, direction);
    if (metadata?.agentRole === "subagent") {
      const parent = findTerminalLeaf(state.workspaces, workspaceId, surfaceId);
      const parsed = parseSshCommandLine(parent?.command ?? parent?.sshCommand);
      const connection = parent?.sshConnection ?? parsed?.connection;
      const aiKind = detectRestorableAgentCommand(command);
      if (connection) {
        const cwd = runtime.getLeafCwd(workspaceId, surfaceId);
        const remote = buildAiRemoteCommand(command, cwd);
        return state.splitLeafWithCommand(
          workspaceId,
          surfaceId,
          direction,
          buildSshCommandWithRemoteCmdFromConnection(connection, remote, true),
          {
            ...metadata,
            aiKind,
            aiSshTarget: connection.target,
            sshConnection: connection,
            sshRemoteCommand: remote,
          },
        );
      }
      return state.splitLeafWithCommand(workspaceId, surfaceId, direction, command, {
        ...metadata,
        aiKind,
      });
    }
    return state.splitLeafWithCommand(workspaceId, surfaceId, direction, command);
  },
  focus: (workspaceId, surfaceId) => {
    const state = useWorkspaceStore.getState();
    state.setActive(workspaceId);
    state.setFocusedLeaf(workspaceId, surfaceId);
  },
  write: async (surfaceId, text) => {
    const instance = terminalInstances.get(surfaceId);
    if (!instance) throw new Error("Terminal is not ready");
    await tauriPtyBackend.write(instance.ptyId, text);
  },
  readVisibleText: (surfaceId, rows) => {
    const instance = terminalInstances.get(surfaceId);
    if (!instance) throw new Error("Terminal is not ready");
    return instance.surface.getVisibleText(rows);
  },
  openBrowser: (workspaceId, surfaceId, url) =>
    useWorkspaceStore.getState().openBrowser(
      workspaceId,
      surfaceId,
      normalizeBrowserUrl(url),
    ),
  browser: (surfaceId, action, value) => {
    const label = browserWebviewLabel(surfaceId);
    switch (action) {
      case "navigate":
        return invoke("browser_navigate", { label, url: value });
      case "reload":
        return invoke("browser_reload", { label });
      case "url":
        return invoke("browser_current_url", { label });
      case "snapshot":
        return invoke("browser_snapshot", { label });
      case "console":
        return invoke("browser_console_logs", { label });
      case "screenshot":
        return invoke("browser_screenshot", { label });
    }
  },
  setBrowserUrl: (workspaceId, surfaceId, url) => {
    useWorkspaceStore.getState().setBrowserUrl(workspaceId, surfaceId, url);
  },
};

export const executeAppControlRequest = (request: ControlRequestEvent): Promise<unknown> =>
  executeControlRequest(request, runtime);
