import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SshAuth =
  | { type: "password"; password: string }
  | { type: "privateKey"; privateKey: string; passphrase?: string };

export interface SshConnectRequest {
  host: string;
  port: number;
  user: string;
  trustedFingerprint?: string;
  auth: SshAuth;
}

export interface SshConnectResult {
  connected: boolean;
  trustRequired: boolean;
  fingerprint: string;
}

export interface MobileAgentTransportEvent {
  channelId: string;
  kind: "stdout" | "stderr" | "exit" | "closed";
  data?: string;
  exitStatus?: number;
}

export const connectSsh = (request: SshConnectRequest): Promise<SshConnectResult> =>
  invoke("mobile_ssh_connect", { request });

export const disconnectSsh = (): Promise<void> => invoke("mobile_ssh_disconnect");

export const openAgent = (
  channelId: string,
  provider: "codex" | "claude",
  sessionId?: string,
  cwd?: string,
): Promise<void> => invoke("mobile_agent_open", {
  channelId,
  provider,
  sessionId,
  cwd,
});

export const listClaudeSessions = (channelId: string): Promise<void> =>
  invoke("mobile_claude_sessions", { channelId });

export const writeAgentLine = (channelId: string, line: string): Promise<void> =>
  invoke("mobile_agent_write", { channelId, line });

export const closeAgent = (channelId: string): Promise<void> =>
  invoke("mobile_agent_close", { channelId });

export const onAgentTransport = (
  handler: (event: MobileAgentTransportEvent) => void,
): Promise<UnlistenFn> => listen<MobileAgentTransportEvent>(
  "mobile-agent-transport",
  ({ payload }) => handler(payload),
);
