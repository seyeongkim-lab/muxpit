import { create } from "zustand";

interface SettingsState {
  fontSize: number;
  fontFamily: string;
  theme: "catppuccin-mocha";

  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
}

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;

// Load saved settings from localStorage
const loadSaved = () => {
  try {
    const saved = localStorage.getItem("wmux-settings");
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
};

const saved = loadSaved();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  fontSize: saved.fontSize ?? 14,
  fontFamily: saved.fontFamily ?? "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace",
  theme: "catppuccin-mocha",

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
}));

const saveSettings = (state: SettingsState) => {
  try {
    localStorage.setItem(
      "wmux-settings",
      JSON.stringify({
        fontSize: state.fontSize,
        fontFamily: state.fontFamily,
      }),
    );
  } catch {}
};
