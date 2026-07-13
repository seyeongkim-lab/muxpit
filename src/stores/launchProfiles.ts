import { create } from "zustand";
import {
  captureLaunchProfile,
  materializeLaunchProfile,
  parseLaunchProfiles,
  type LaunchProfile,
} from "../utils/launchProfile.ts";
import type { Workspace } from "./workspace.ts";
import { useWorkspaceStore } from "./workspace.ts";

const STORAGE_KEY = "wmux-launch-profiles";
let nodeCounter = 0;

const nextNodeId = (): string => `profile-node-${Date.now()}-${nodeCounter++}`;

const loadProfiles = (): LaunchProfile[] => {
  if (typeof localStorage === "undefined") return [];
  return parseLaunchProfiles(localStorage.getItem(STORAGE_KEY));
};

const persistProfiles = (profiles: LaunchProfile[]): void => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
};

interface LaunchProfileState {
  profiles: LaunchProfile[];
  panelOpen: boolean;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  saveWorkspace: (
    name: string,
    workspace: Workspace,
    cwdByLeaf?: Record<string, string>,
  ) => boolean;
  launch: (id: string) => string | null;
  remove: (id: string) => void;
}

export const useLaunchProfileStore = create<LaunchProfileState>((set, get) => ({
  profiles: loadProfiles(),
  panelOpen: false,
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  saveWorkspace: (name, workspace, cwdByLeaf = {}) => {
    const profile = captureLaunchProfile(name, workspace, Date.now(), cwdByLeaf);
    if (!profile) return false;
    set((state) => {
      const profiles = [
        profile,
        ...state.profiles.filter((candidate) => candidate.name !== profile.name),
      ].slice(0, 50);
      persistProfiles(profiles);
      return { profiles };
    });
    return true;
  },
  launch: (id) => {
    const profile = get().profiles.find((candidate) => candidate.id === id);
    if (!profile) return null;
    const { layout, focusedLeafId } = materializeLaunchProfile(profile, nextNodeId);
    return useWorkspaceStore.getState().addWorkspaceWithLayout(
      profile.name,
      layout,
      focusedLeafId,
    );
  },
  remove: (id) => {
    set((state) => {
      const profiles = state.profiles.filter((profile) => profile.id !== id);
      persistProfiles(profiles);
      return { profiles };
    });
  },
}));
