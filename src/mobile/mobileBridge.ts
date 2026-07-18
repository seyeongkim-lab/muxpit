import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentExecutionSettings } from "./agentSessionRuntime.ts";
import type { AgentProvider } from "./agentProtocol.ts";
import type { HostProfile } from "./hostProfiles.ts";

export type SshAuth =
  | { type: "password"; password: string }
  | { type: "privateKey"; privateKey: string; passphrase?: string };

export interface SshConnectRequest {
  profileId: string;
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

export const disconnectSsh = (profileId?: string): Promise<void> =>
  invoke("mobile_ssh_disconnect", { profileId });

export const probeSsh = (profileId: string): Promise<boolean> =>
  invoke("mobile_ssh_probe", { profileId });

export const saveSshCredential = (profileId: string, auth: SshAuth): Promise<void> =>
  invoke("mobile_credential_save", { profileId, auth });

export const loadSshCredential = (profileId: string): Promise<SshAuth | null> =>
  invoke<SshAuth | null>("mobile_credential_load", { profileId });

export const saveHostProfilesSecure = (profiles: HostProfile[]): Promise<void> =>
  invoke("mobile_profiles_save", { profiles });

export const loadHostProfilesSecure = (): Promise<HostProfile[]> =>
  invoke<HostProfile[]>("mobile_profiles_load");

export const listInstalledAgents = (profileId: string): Promise<AgentProvider[]> =>
  invoke<AgentProvider[]>("mobile_agent_installed", { profileId });

export const openAgent = (
  profileId: string,
  channelId: string,
  provider: AgentProvider,
  sessionId?: string,
  cwd?: string,
  settings?: AgentExecutionSettings,
): Promise<void> => invoke("mobile_agent_open", {
  profileId,
  channelId,
  provider,
  sessionId,
  cwd,
  settings: settings
    ? { model: settings.model, effort: settings.effort }
    : null,
});

export const listClaudeSessions = (profileId: string, channelId: string): Promise<void> =>
  invoke("mobile_claude_sessions", { profileId, channelId });

export const loadClaudeSession = (
  profileId: string,
  channelId: string,
  sessionId: string,
): Promise<void> => invoke("mobile_claude_session", { profileId, channelId, sessionId });

export const listSessionGoals = (profileId: string, channelId: string): Promise<void> =>
  invoke("mobile_session_goals", { profileId, channelId });

export const setSessionGoal = (
  profileId: string,
  channelId: string,
  key: string,
  payload: string,
): Promise<void> => invoke("mobile_session_goal_set", { profileId, channelId, key, payload });

export const deleteSessionGoal = (
  profileId: string,
  channelId: string,
  key: string,
): Promise<void> => invoke("mobile_session_goal_delete", { profileId, channelId, key });

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
