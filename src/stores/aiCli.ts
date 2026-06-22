import { create } from "zustand";
import type { AiKind } from "./workspace";
import type { SshHost } from "./sshHosts";
import { buildSshCommandWithRemoteCmdFromBase, buildSshConnection } from "./sshHosts";
import {
  buildSshCommandWithRemoteCmdFromConnection,
  parseSshCommandLine,
  type SshConnection,
} from "../utils/sshConnection";
import { buildAiRemoteCommand } from "../utils/aiRemoteCommand";
import { appInvoke } from "../utils/appBridge";

export const AI_KINDS: AiKind[] = ["claude", "codex", "gemini", "copilot"];

export const AI_LABEL: Record<AiKind, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  copilot: "copilot",
};

const AI_REMOTE_CMD: Record<AiKind, string> = {
  claude: buildAiRemoteCommand("claude --dangerously-skip-permissions"),
  codex: buildAiRemoteCommand("codex"),
  gemini: buildAiRemoteCommand("gemini"),
  copilot: buildAiRemoteCommand("copilot"),
};

/** Parse `user@host` from a free-form ssh command. Returns null if not found. */
export const parseSshTarget = (cmd: string): string | null => {
  const parsed = parseSshCommandLine(cmd);
  if (parsed) return parsed.connection.target;
  const m = cmd.match(/(\S+@\S+)/);
  return m ? m[1] : null;
};

export interface AiLaunchSpec {
  command: string;
  sshConnection?: SshConnection;
  sshRemoteCommand?: string;
}

/**
 * Build the ssh command that drops the user straight into the requested AI CLI.
 * When `host` is known we use the canonical builder so flags (port, identity,
 * default opts) match the rest of the app. Otherwise we splice `-t` and the
 * remote command into the raw ssh string used by session-restore.
 */
export const buildAiLaunchCommand = (
  kind: AiKind,
  rawSshCommand: string,
  host?: SshHost,
): string => {
  return buildAiLaunchSpec(kind, rawSshCommand, host ? buildSshConnection(host) : undefined).command;
};

export const buildAiLaunchSpec = (
  kind: AiKind,
  rawSshCommand: string,
  sshConnection?: SshConnection,
): AiLaunchSpec => {
  const remote = AI_REMOTE_CMD[kind];
  const connection = sshConnection ?? parseSshCommandLine(rawSshCommand)?.connection;
  if (connection) {
    return {
      command: buildSshCommandWithRemoteCmdFromConnection(connection, remote, true),
      sshConnection: connection,
      sshRemoteCommand: remote,
    };
  }
  return {
    command: buildSshCommandWithRemoteCmdFromBase(rawSshCommand, remote, true),
  };
};

interface AiCliState {
  /** Map of `user@host` → set of AI kinds confirmed installed. */
  availableByHost: Record<string, Set<AiKind>>;
  /** Targets currently being probed; suppresses duplicate concurrent invokes. */
  probing: Set<string>;

  probe: (sshTarget: string, sshCommand: string, sshConnection?: SshConnection) => Promise<void>;
  has: (sshTarget: string, kind: AiKind) => boolean;
  available: (sshTarget: string) => Set<AiKind> | undefined;
}

export const useAiCliStore = create<AiCliState>((set, get) => ({
  availableByHost: {},
  probing: new Set(),

  probe: async (sshTarget, sshCommand, sshConnection) => {
    const state = get();
    if (state.availableByHost[sshTarget] || state.probing.has(sshTarget)) return;
    if (!sshConnection && !parseSshCommandLine(sshCommand)) {
      return;
    }
    set((s) => {
      const next = new Set(s.probing);
      next.add(sshTarget);
      return { probing: next };
    });
    try {
      // One connection-failure retry: a fresh connect fires this probe alongside
      // the tmux probe and the user's own ssh, so the first attempt occasionally
      // loses the race. Only a *successful* probe is cached (an empty result =
      // genuinely nothing installed). A probe that never succeeds stays uncached
      // so the next connect re-probes — otherwise a single transient SSH hiccup
      // would hide the AI pane for the whole session until an app restart.
      let result: Record<string, boolean> | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = await appInvoke<Record<string, boolean>>("check_remote_clis", {
            sshCommand,
            sshConnection: sshConnection ?? null,
            names: AI_KINDS,
          });
          break;
        } catch {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
        }
      }
      if (result) {
        const found = new Set<AiKind>();
        for (const k of AI_KINDS) if (result[k]) found.add(k);
        set((s) => ({ availableByHost: { ...s.availableByHost, [sshTarget]: found } }));
      }
    } finally {
      set((s) => {
        const next = new Set(s.probing);
        next.delete(sshTarget);
        return { probing: next };
      });
    }
  },

  has: (sshTarget, kind) => !!get().availableByHost[sshTarget]?.has(kind),
  available: (sshTarget) => get().availableByHost[sshTarget],
}));
