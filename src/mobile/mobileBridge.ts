import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentExecutionSettings } from "./agentSessionRuntime.ts";
import type { HostProfile } from "./hostProfiles.ts";

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

export const probeSsh = (): Promise<boolean> => invoke("mobile_ssh_probe");

export const saveSshCredential = (profileId: string, auth: SshAuth): Promise<void> =>
  invoke("mobile_credential_save", { profileId, auth });

export const loadSshCredential = (profileId: string): Promise<SshAuth | null> =>
  invoke<SshAuth | null>("mobile_credential_load", { profileId });

export const saveHostProfilesSecure = (profiles: HostProfile[]): Promise<void> =>
  invoke("mobile_profiles_save", { profiles });

export const loadHostProfilesSecure = (): Promise<HostProfile[]> =>
  invoke<HostProfile[]>("mobile_profiles_load");

export const openAgent = (
  channelId: string,
  provider: "codex" | "claude",
  sessionId?: string,
  cwd?: string,
  settings?: AgentExecutionSettings,
): Promise<void> => invoke("mobile_agent_open", {
  channelId,
  provider,
  sessionId,
  cwd,
  settings: settings
    ? { model: settings.model, effort: settings.effort }
    : null,
});

export const listClaudeSessions = (channelId: string): Promise<void> =>
  invoke("mobile_claude_sessions", { channelId });

export const loadClaudeSession = (channelId: string, sessionId: string): Promise<void> =>
  invoke("mobile_claude_session", { channelId, sessionId });

export const writeAgentLine = (channelId: string, line: string): Promise<void> =>
  invoke("mobile_agent_write", { channelId, line });

export const probeAgent = (channelId: string): Promise<boolean> =>
  invoke("mobile_agent_probe", { channelId });

export const closeAgent = (channelId: string): Promise<void> =>
  invoke("mobile_agent_close", { channelId });

export const onAgentTransport = (
  handler: (event: MobileAgentTransportEvent) => void,
): Promise<UnlistenFn> => listen<MobileAgentTransportEvent>(
  "mobile-agent-transport",
  ({ payload }) => handler(payload),
);
