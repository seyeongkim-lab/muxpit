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
   * When true, new sessions to this host are wrapped in `tmux -CC new -A -s wmux-<host>`
   * so the remote shell survives SSH disconnection and wmux restarts. Requires
   * tmux 3.2+ on the remote.
   */
  persistMode?: boolean;
}

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
      if (Array.isArray(parsed)) return parsed;
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

/** Build an SSH command string from a host config */
export const buildSshCommand = (host: SshHost): string => {
  const parts: string[] = ["ssh"];

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
  const parts: string[] = ["ssh", "-t"];

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
