import { create } from "zustand";
import {
  SSH_DEFAULT_OPTS,
  buildSshCommandWithRemoteCmdFromConnection,
  sshConnectionToCommandLine,
  type SshConnection,
} from "../utils/sshConnection";

export type { SshConnection } from "../utils/sshConnection";
export {
  buildSshCommandWithRemoteCmdFromBase,
  quoteCommandArg,
  quotePosixShellArg,
} from "../utils/sshConnection";

export interface SshHost {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  keyPath?: string;
  color?: string;
  /**
   * Persist-mode policy for new sessions:
   * - `"on"`: always wrap the remote shell in `tmux -CC new -A -s muxpit-<host>`
   * - `"off"`: never wrap; plain SSH
   * - `"auto"` (default): probe the host for tmux 3.2+ at connect time and wrap when found
   *
   * Legacy values (boolean/undefined) from earlier versions are migrated on load:
   * `true → "on"`, `false → "off"`, `undefined → "auto"`.
   */
  persistMode?: PersistMode;
}

export type PersistMode = "off" | "on" | "auto";

export const PERSIST_MODE_CHOICES: { value: PersistMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Probe for tmux 3.2+ on connect." },
  { value: "on", label: "Always on", hint: "Force tmux wrapping; fails if unavailable." },
  { value: "off", label: "Off", hint: "Plain SSH; no session persistence." },
];

const migratePersistMode = (value: unknown): PersistMode => {
  if (value === "on" || value === "off" || value === "auto") return value;
  if (value === true) return "on";
  if (value === false) return "off";
  return "auto";
};

interface SshHostsState {
  hosts: SshHost[];
  addHost: (host: Omit<SshHost, "id">) => void;
  updateHost: (id: string, patch: Partial<Omit<SshHost, "id">>) => void;
  removeHost: (id: string) => void;
  reorderHosts: (ids: string[]) => void;
}

const STORAGE_KEY = "muxpit-ssh-hosts";

// Strip an accidental leading dot from id_rsa/ed25519/ecdsa/dsa filenames in saved keyPaths
// (e.g. `~/.ssh/.id_ed25519` → `~/.ssh/id_ed25519`). OpenSSH prints "Identity file ... not
// accessible" at connect when the path is wrong; we silently fix it on load.
const normalizeKeyPath = (p?: string): string | undefined => {
  if (!p) return p;
  return p.replace(/([\\/])\.id_(rsa|ed25519|ecdsa|dsa)\b/gi, "$1id_$2");
};

const loadSaved = (): SshHost[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((h: SshHost & { persistMode?: unknown }) => ({
          ...h,
          keyPath: normalizeKeyPath(h.keyPath),
          persistMode: migratePersistMode(h.persistMode),
        }));
      }
    }
  } catch {}
  return [];
};

const saveHosts = (hosts: SshHost[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
  } catch {}
};

let counter = 0;
const genId = () => `ssh-${Date.now()}-${counter++}`;

const initialHosts = loadSaved();
// Persist any keyPath corrections made during load so the cleanup is permanent.
if (initialHosts.length) saveHosts(initialHosts);

export const useSshHostsStore = create<SshHostsState>((set, get) => ({
  hosts: initialHosts,

  addHost: (host) => {
    const newHost: SshHost = { ...host, id: genId() };
    const next = [...get().hosts, newHost];
    set({ hosts: next });
    saveHosts(next);
  },

  updateHost: (id, patch) => {
    const next = get().hosts.map((h) => (h.id === id ? { ...h, ...patch } : h));
    set({ hosts: next });
    saveHosts(next);
  },

  removeHost: (id) => {
    const next = get().hosts.filter((h) => h.id !== id);
    set({ hosts: next });
    saveHosts(next);
  },

  reorderHosts: (ids) => {
    const hostMap = new Map(get().hosts.map((h) => [h.id, h]));
    const reordered = ids.flatMap((id) => {
      const h = hostMap.get(id);
      return h ? [h] : [];
    });
    set({ hosts: reordered });
    saveHosts(reordered);
  },
}));

export const buildSshConnection = (host: SshHost): SshConnection => {
  const options = [...SSH_DEFAULT_OPTS];
  if (host.port !== 22) {
    options.push("-p", String(host.port));
  }

  if (host.keyPath) {
    options.push("-i", host.keyPath);
  }

  return {
    program: "ssh",
    options,
    target: `${host.user}@${host.host}`,
  };
};

/** Build an SSH command string from a host config */
export const buildSshCommand = (host: SshHost): string => {
  return sshConnectionToCommandLine(buildSshConnection(host));
};

/** Build an SSH command that executes a remote command (with -t for PTY allocation) */
export const buildSshCommandWithRemoteCmd = (host: SshHost, remoteCmd: string): string => {
  return buildSshCommandWithRemoteCmdFromConnection(buildSshConnection(host), remoteCmd, true);
};
