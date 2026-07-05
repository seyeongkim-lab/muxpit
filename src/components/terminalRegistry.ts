import { useSettingsStore } from "../stores/settings";
import { getResolvedTheme } from "../themes";
import { tauriPtyBackend } from "../utils/tauriPtyBackend";
import type { TerminalDisposable, TerminalSurface } from "./terminalSurface";

export interface TerminalInstance {
  surface: TerminalSurface;
  ptyId: number;
  cleanup: {
    unlistenOutput: () => void;
    unlistenExit: () => void;
    onData: TerminalDisposable;
    onResize: TerminalDisposable;
    onPaste: TerminalDisposable;
    writeBuffer?: TerminalDisposable;
  };
}

// Keeps terminal surface instances alive across React re-renders. Split out of Terminal.tsx
// so the component file can Fast-Refresh cleanly (Vite invalidates the whole
// module when component and non-component exports are mixed).
export const terminalInstances = new Map<string, TerminalInstance>();

export const destroyTerminal = (leafId: string) => {
  const instance = terminalInstances.get(leafId);
  if (!instance) return;
  tauriPtyBackend.kill(instance.ptyId).catch(() => {});
  instance.cleanup.unlistenOutput();
  instance.cleanup.unlistenExit();
  instance.cleanup.onData.dispose();
  instance.cleanup.onResize.dispose();
  instance.cleanup.onPaste.dispose();
  instance.cleanup.writeBuffer?.dispose();
  instance.surface.dispose();
  terminalInstances.delete(leafId);
};

export const destroyAllTerminals = (leafIds: string[]) => {
  leafIds.forEach(destroyTerminal);
};

// Apply theme changes to all existing terminals in real-time.
useSettingsStore.subscribe((state, prev) => {
  if (
    state.themeName !== prev.themeName ||
    state.customColors !== prev.customColors ||
    state.customThemes !== prev.customThemes
  ) {
    const theme = getResolvedTheme(state.themeName, state.customColors, state.customThemes);
    terminalInstances.forEach(({ surface }) => {
      surface.setTheme(theme);
    });
  }

  if (state.enableWebglRenderer !== prev.enableWebglRenderer) {
    terminalInstances.forEach((instance) => instance.surface.setWebglRenderer(state.enableWebglRenderer));
  }
});
