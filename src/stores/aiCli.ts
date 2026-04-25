import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AiKind } from "./workspace";
import type { SshHost } from "./sshHosts";
import { buildSshCommandWithRemoteCmd } from "./sshHosts";

export const AI_KINDS: AiKind[] = ["claude", "codex", "gemini", "copilot"];

export const AI_LABEL: Record<AiKind, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  copilot: "copilot",
};

// Remote command launched inside a login shell on the SSH target.
//   - `bash -lc` loads the user's profile PATH (AI CLIs commonly live in
//     ~/.local/bin or a node version-manager dir that non-login shells miss).
//   - The trailing `; exec bash -l` keeps the pane alive even when the AI CLI
//     exits non-zero (missing binary, install bailout, OAuth flow that
//     short-circuits, etc). Without this, the parent ssh closes too and the
//     pane just shows `[Process exited]` over a blank screen — the user can't
//     read the failure or run the install command by hand.
const AI_REMOTE_CMD: Record<AiKind, string> = {
  claude: "bash -lc 'claude --dangerously-skip-permissions; exec bash -l'",
  codex: "bash -lc 'codex; exec bash -l'",
  gemini: "bash -lc 'gemini; exec bash -l'",
  copilot: "bash -lc 'copilot; exec bash -l'",
};

/** Parse `user@host` from a free-form ssh command. Returns null if not found. */
export const parseSshTarget = (cmd: string): string | null => {
  for (const part of cmd.split(/\s+/)) {
    if (part.startsWith("-") || part.startsWith('"') || part.toLowerCase().includes("ssh")) continue;
    if (part.includes("@")) return part;
  }
  const m = cmd.match(/(\S+@\S+)/);
  return m ? m[1] : null;
};

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
  const remote = AI_REMOTE_CMD[kind];
  if (host) return buildSshCommandWithRemoteCmd(host, remote);
  return rawSshCommand.replace(/^ssh\b/, "ssh -t") + ` "${remote}"`;
};

interface AiCliState {
  /** Map of `user@host` → set of AI kinds confirmed installed. */
  availableByHost: Record<string, Set<AiKind>>;
  /** Targets currently being probed; suppresses duplicate concurrent invokes. */
  probing: Set<string>;

  probe: (sshTarget: string, sshCommand: string) => Promise<void>;
  has: (sshTarget: string, kind: AiKind) => boolean;
  available: (sshTarget: string) => Set<AiKind> | undefined;
}

export const useAiCliStore = create<AiCliState>((set, get) => ({
  availableByHost: {},
  probing: new Set(),

  probe: async (sshTarget, sshCommand) => {
    const state = get();
    if (state.availableByHost[sshTarget] || state.probing.has(sshTarget)) return;
    set((s) => {
      const next = new Set(s.probing);
      next.add(sshTarget);
      return { probing: next };
    });
    try {
      const result = await invoke<Record<string, boolean>>("check_remote_clis", {
        sshCommand,
        names: AI_KINDS,
      });
      const found = new Set<AiKind>();
      for (const k of AI_KINDS) if (result[k]) found.add(k);
      set((s) => ({ availableByHost: { ...s.availableByHost, [sshTarget]: found } }));
    } catch {
      // Treat probe failure as "nothing available" so the toolbar simply hides.
      set((s) => ({ availableByHost: { ...s.availableByHost, [sshTarget]: new Set() } }));
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
