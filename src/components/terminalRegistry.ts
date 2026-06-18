import { invoke } from "@tauri-apps/api/core";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useSettingsStore } from "../stores/settings";
import { getResolvedTheme } from "../themes";

export interface TerminalInstance {
  term: XTerm;
  fitAddon: FitAddon;
  ptyId: number;
  webglAddon?: WebglAddon;
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

export const loadWebglAddon = (term: XTerm): WebglAddon | undefined => {
  try {
    const addon = new WebglAddon();
    term.loadAddon(addon);
    return addon;
  } catch {
    return undefined;
  }
};

export const setWebglRenderer = (instance: TerminalInstance, enabled: boolean) => {
  if (enabled) {
    if (!instance.webglAddon) instance.webglAddon = loadWebglAddon(instance.term);
    return;
  }

  if (!instance.webglAddon) return;
  try {
    instance.webglAddon.dispose();
  } catch {}
  instance.webglAddon = undefined;
  if (instance.term.rows > 0) instance.term.refresh(0, instance.term.rows - 1);
};

export const destroyTerminal = (leafId: string) => {
  const instance = terminalInstances.get(leafId);
  if (!instance) return;
  invoke("kill_pty", { id: instance.ptyId }).catch(() => {});
  instance.webglAddon?.dispose();
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

  if (state.enableWebglRenderer !== prev.enableWebglRenderer) {
    terminalInstances.forEach((instance) => setWebglRenderer(instance, state.enableWebglRenderer));
  }
});
