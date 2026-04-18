import { create } from "zustand";
import type { CustomColors, ThemeColorKey } from "../themes";

export type PrefixKey = "off" | "ctrl+b" | "ctrl+shift+b" | "ctrl+a" | "ctrl+space" | "ctrl+q" | "ctrl+\\";

export const PREFIX_KEY_CHOICES: { value: PrefixKey; label: string }[] = [
  { value: "ctrl+shift+b", label: "Ctrl+Shift+B" },
  { value: "ctrl+b", label: "Ctrl+B (tmux default)" },
  { value: "ctrl+a", label: "Ctrl+A (screen default)" },
  { value: "ctrl+space", label: "Ctrl+Space" },
  { value: "ctrl+q", label: "Ctrl+Q" },
  { value: "ctrl+\\", label: "Ctrl+\\" },
  { value: "off", label: "Off (disabled)" },
];

interface SettingsState {
  fontSize: number;
  fontFamily: string;
  themeName: string;
  customColors: CustomColors;
  prefixKey: PrefixKey;

  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setThemeName: (name: string) => void;
  setCustomColor: (themeName: string, key: ThemeColorKey, color: string) => void;
  resetCustomColors: (themeName: string) => void;
  resetSingleColor: (themeName: string, key: ThemeColorKey) => void;
  setPrefixKey: (key: PrefixKey) => void;
}

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;

// Default font stack — Nerd Font variants first so Powerline/starship glyphs (PUA code
// points) render. Windows ships the Caskaydia NFM variant via the "Cascadia Code Nerd Font"
// installer; the other names are common macOS/Linux installs. xterm requires a monospace
// family, hence the NFM/Mono suffix where available.
const DEFAULT_FONT_FAMILY =
  "'CaskaydiaMono NFM', 'CaskaydiaCove NFM', 'JetBrainsMono NFM', 'MesloLGS NF', 'FiraCode Nerd Font Mono', 'Hack Nerd Font Mono', 'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace";

// Load saved settings from localStorage
const loadSaved = () => {
  try {
    const saved = localStorage.getItem("wmux-settings");
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
};

const saved = loadSaved();

// One-shot migration: if the user's persisted fontFamily predates the Nerd-Font default
// (saved before any NF glyph was referenced), upgrade it so terminal prompts render.
if (saved.fontFamily && !/\b(Nerd|NF|NFM|Powerline)\b/i.test(saved.fontFamily)) {
  saved.fontFamily = DEFAULT_FONT_FAMILY;
  try {
    localStorage.setItem("wmux-settings", JSON.stringify(saved));
  } catch {}
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  fontSize: saved.fontSize ?? 14,
  fontFamily: saved.fontFamily ?? DEFAULT_FONT_FAMILY,
  themeName: saved.themeName ?? "Catppuccin Mocha",
  customColors: saved.customColors ?? {},
  prefixKey: saved.prefixKey ?? "ctrl+shift+b",

  increaseFontSize: () => {
    const next = Math.min(get().fontSize + 1, FONT_SIZE_MAX);
    set({ fontSize: next });
    saveSettings(get());
  },

  decreaseFontSize: () => {
    const next = Math.max(get().fontSize - 1, FONT_SIZE_MIN);
    set({ fontSize: next });
    saveSettings(get());
  },

  setFontSize: (size: number) => {
    set({ fontSize: Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size)) });
    saveSettings(get());
  },

  setFontFamily: (family: string) => {
    set({ fontFamily: family });
    saveSettings(get());
  },

  setThemeName: (name: string) => {
    set({ themeName: name });
    saveSettings(get());
  },

  setCustomColor: (themeName: string, key: ThemeColorKey, color: string) => {
    const prev = get().customColors;
    set({
      customColors: {
        ...prev,
        [themeName]: { ...prev[themeName], [key]: color },
      },
    });
    saveSettings(get());
  },

  resetCustomColors: (themeName: string) => {
    const prev = { ...get().customColors };
    delete prev[themeName];
    set({ customColors: prev });
    saveSettings(get());
  },

  resetSingleColor: (themeName: string, key: ThemeColorKey) => {
    const prev = get().customColors;
    const themeOverrides = { ...prev[themeName] };
    delete themeOverrides[key];
    const next = { ...prev };
    if (Object.keys(themeOverrides).length === 0) {
      delete next[themeName];
    } else {
      next[themeName] = themeOverrides;
    }
    set({ customColors: next });
    saveSettings(get());
  },

  setPrefixKey: (key: PrefixKey) => {
    set({ prefixKey: key });
    saveSettings(get());
  },
}));

const saveSettings = (state: SettingsState) => {
  try {
    localStorage.setItem(
      "wmux-settings",
      JSON.stringify({
        fontSize: state.fontSize,
        fontFamily: state.fontFamily,
        themeName: state.themeName,
        customColors: state.customColors,
        prefixKey: state.prefixKey,
      }),
    );
  } catch {}
};
