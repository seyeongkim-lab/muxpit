import { create } from "zustand";

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
   * - `"on"`: always wrap the remote shell in `tmux -CC new -A -s wmux-<host>`
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

const STORAGE_KEY = "wmux-ssh-hosts";

const loadSaved = (): SshHost[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((h: SshHost & { persistMode?: unknown }) => ({
          ...h,
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

export const useSshHostsStore = create<SshHostsState>((set, get) => ({
  hosts: loadSaved(),

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

// Common SSH options for wmux sessions:
// - accept-new: first-contact hosts are auto-added to known_hosts (no stdin prompt that
//   stalls the PTY). Key-change conflicts still reject, preserving TOFU safety.
// - ServerAliveInterval/CountMax: detect dead peers within ~90s so tmux-CC reconnect
//   can trigger instead of hanging indefinitely.
const SSH_DEFAULT_OPTS = [
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
];

/** Build an SSH command string from a host config */
export const buildSshCommand = (host: SshHost): string => {
  const parts: string[] = ["ssh", ...SSH_DEFAULT_OPTS];

  if (host.port !== 22) {
    parts.push("-p", String(host.port));
  }

  if (host.keyPath) {
    parts.push("-i", host.keyPath);
  }

  parts.push(`${host.user}@${host.host}`);

  return parts.join(" ");
};

/** Build an SSH command that executes a remote command (with -t for PTY allocation) */
export const buildSshCommandWithRemoteCmd = (host: SshHost, remoteCmd: string): string => {
  const parts: string[] = ["ssh", "-t", ...SSH_DEFAULT_OPTS];

  if (host.port !== 22) {
    parts.push("-p", String(host.port));
  }

  if (host.keyPath) {
    parts.push("-i", host.keyPath);
  }

  parts.push(`${host.user}@${host.host}`);
  parts.push(`"${remoteCmd}"`);

  return parts.join(" ");
};
