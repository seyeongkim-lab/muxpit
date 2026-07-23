import { create } from "zustand";
import type { SshConnection } from "../utils/sshConnection";

// Where a viewed file lives: a local path, or a path on an SSH host. `cwd`
// resolves relative paths coming out of agent conversations.
export interface FileViewerTarget {
  cwd?: string | null;
  sshCommand?: string | null;
  sshConnection?: SshConnection | null;
}

interface FileViewerState {
  open: boolean;
  path: string | null;
  target: FileViewerTarget;
  // Bumped on every openFile so re-clicking the same path refetches.
  requestNonce: number;
  openFile: (path: string, target: FileViewerTarget) => void;
  close: () => void;
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  open: false,
  path: null,
  target: {},
  requestNonce: 0,
  openFile: (path, target) =>
    set((state) => ({ open: true, path, target, requestNonce: state.requestNonce + 1 })),
  close: () => set({ open: false }),
}));
