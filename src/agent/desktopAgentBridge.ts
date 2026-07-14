import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AiKind } from "../stores/workspace.ts";
import type { SshConnection } from "../utils/sshConnection.ts";

export interface DesktopAgentTarget {
  cwd?: string;
  sshCommand?: string;
  sshConnection?: SshConnection;
}

export interface DesktopAgentTransportEvent {
  channelId: string;
  kind: "stdout" | "stderr" | "exit" | "closed";
  data?: string;
  exitStatus?: number;
}

const targetArgs = (target: DesktopAgentTarget) => ({
  cwd: target.cwd ?? null,
  sshCommand: target.sshCommand ?? null,
  sshConnection: target.sshConnection ?? null,
});

export const openDesktopAgent = (
  channelId: string,
  provider: AiKind,
  target: DesktopAgentTarget,
  sessionId?: string,
): Promise<void> => invoke("desktop_agent_open", {
  channelId,
  provider,
  sessionId: sessionId ?? null,
  ...targetArgs(target),
});

export const writeDesktopAgentLine = (channelId: string, line: string): Promise<void> =>
  invoke("desktop_agent_write", { channelId, line });

export const closeDesktopAgent = (channelId: string): Promise<void> =>
  invoke("desktop_agent_close", { channelId });

export const listDesktopClaudeSessions = (
  channelId: string,
  target: DesktopAgentTarget,
): Promise<void> => invoke("desktop_claude_sessions", {
  channelId,
  ...targetArgs(target),
});

export const loadDesktopClaudeSession = (
  channelId: string,
  sessionId: string,
  target: DesktopAgentTarget,
): Promise<void> => invoke("desktop_claude_session", {
  channelId,
  sessionId,
  ...targetArgs(target),
});

export const onDesktopAgentTransport = (
  handler: (event: DesktopAgentTransportEvent) => void,
): Promise<UnlistenFn> => listen<DesktopAgentTransportEvent>(
  "desktop-agent-transport",
  (event) => handler(event.payload),
);

export const probeDesktopAgents = async (
  providers: AiKind[],
  target: DesktopAgentTarget,
): Promise<Set<AiKind>> => {
  const result = target.sshCommand || target.sshConnection
    ? await invoke<Record<string, boolean>>("check_remote_clis", {
        sshCommand: target.sshCommand ?? null,
        sshConnection: target.sshConnection ?? null,
        names: providers,
      })
    : await invoke<Record<string, boolean>>("check_local_clis", { names: providers });
  return new Set(providers.filter((provider) => result[provider]));
};
