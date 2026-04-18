import { invoke } from "@tauri-apps/api/core";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useSettingsStore } from "../stores/settings";
import { getResolvedTheme } from "../themes";

export interface TerminalInstance {
  term: XTerm;
  fitAddon: FitAddon;
  ptyId: number;
  cleanup: {
    unlistenOutput: () => void;
    unlistenExit: () => void;
    onData: { dispose: () => void };
    onResize: { dispose: () => void };
  };
}

// Keeps xterm instances alive across React re-renders. Split out of Terminal.tsx
// so the component file can Fast-Refresh cleanly (Vite invalidates the whole
// module when component and non-component exports are mixed).
export const terminalInstances = new Map<string, TerminalInstance>();

export const destroyTerminal = (leafId: string) => {
  const instance = terminalInstances.get(leafId);
  if (!instance) return;
  invoke("kill_pty", { id: instance.ptyId }).catch(() => {});
  instance.cleanup.unlistenOutput();
  instance.cleanup.unlistenExit();
  instance.cleanup.onData.dispose();
  instance.cleanup.onResize.dispose();
  instance.term.dispose();
  terminalInstances.delete(leafId);
};

export const destroyAllTerminals = (leafIds: string[]) => {
  leafIds.forEach(destroyTerminal);
};

// Apply theme changes to all existing terminals in real-time.
useSettingsStore.subscribe((state, prev) => {
  if (state.themeName !== prev.themeName || state.customColors !== prev.customColors) {
    const theme = getResolvedTheme(state.themeName, state.customColors);
    terminalInstances.forEach(({ term }) => {
      term.options.theme = theme;
    });
  }
});
