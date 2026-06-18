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
  fontFamilies: string[]; // ordered fallback list (source of truth)
  fontFamily: string; // derived CSS/xterm stack string, kept in sync
  themeName: string;
  customColors: CustomColors;
  prefixKey: PrefixKey;
  enableWebglRenderer: boolean;
  enableNotifications: boolean;
  enableNotificationSound: boolean;
  notificationSoundDataUrl: string | null;
  notificationSoundName: string | null;

  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setFontSize: (size: number) => void;
  setFontFamilies: (families: string[]) => void;
  setThemeName: (name: string) => void;
  setCustomColor: (themeName: string, key: ThemeColorKey, color: string) => void;
  resetCustomColors: (themeName: string) => void;
  resetSingleColor: (themeName: string, key: ThemeColorKey) => void;
  setPrefixKey: (key: PrefixKey) => void;
  setEnableWebglRenderer: (enabled: boolean) => void;
  setEnableNotifications: (enabled: boolean) => void;
  setEnableNotificationSound: (enabled: boolean) => void;
  setNotificationSound: (name: string, dataUrl: string) => void;
  resetNotificationSound: () => void;
}

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;

// Default font families, in fallback order. Latin coding fonts first (Nerd Font
// variants so Powerline/starship PUA glyphs render), then Korean/CJK fonts so
// Hangul — absent from the coding fonts — falls through per-glyph instead of
// dropping to `monospace` (no Hangul on Windows). `Sarasa Mono K` is a fixed-width
// CJK coding font, so terminal cell alignment stays correct; `Noto Sans CJK KR`
// covers Linux (noto-cjk); `Malgun Gothic` is the Windows fallback.
const DEFAULT_FONT_FAMILIES = [
  "CaskaydiaMono NFM", "CaskaydiaCove NFM", "JetBrainsMono NFM", "MesloLGS NF",
  "FiraCode Nerd Font Mono", "Hack Nerd Font Mono", "JetBrains Mono", "Cascadia Code", "Consolas",
  "Sarasa Mono K", "D2Coding", "Noto Sans KR", "Noto Sans CJK KR", "Malgun Gothic",
];

// Build the CSS/xterm font-family string from an ordered family list. Always ends
// with the generic `monospace` so xterm keeps a final fixed-width fallback.
export const buildFontStack = (families: string[]): string =>
  [...families.map((f) => `'${f}'`), "monospace"].join(", ");

// Load saved settings from localStorage
const loadSaved = () => {
  try {
    const saved = localStorage.getItem("wmux-settings");
    if (saved) return JSON.parse(saved);
  } catch {}
  return {};
};

const saved = loadSaved();
const defaultEnableWebglRenderer =
  typeof navigator === "undefined" ? true : !/linux/i.test(navigator.platform);

// Resolve the ordered font family list. Prefer the new array model; otherwise
// start from defaults (Sarasa-led CJK). Legacy `fontFamily` stack strings are not
// migrated field-by-field — the ordered list supersedes them.
const savedFamilies: string[] = Array.isArray(saved.fontFamilies)
  ? saved.fontFamilies.filter((f: unknown): f is string => typeof f === "string" && f.length > 0)
  : [];
const initialFamilies = savedFamilies.length > 0 ? savedFamilies : DEFAULT_FONT_FAMILIES;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  fontSize: saved.fontSize ?? 14,
  fontFamilies: initialFamilies,
  fontFamily: buildFontStack(initialFamilies),
  themeName: saved.themeName ?? "Catppuccin Mocha",
  customColors: saved.customColors ?? {},
  prefixKey: saved.prefixKey ?? "ctrl+shift+b",
  enableWebglRenderer: saved.enableWebglRenderer ?? defaultEnableWebglRenderer,
  enableNotifications: saved.enableNotifications ?? true,
  enableNotificationSound: saved.enableNotificationSound ?? true,
  notificationSoundDataUrl:
    typeof saved.notificationSoundDataUrl === "string" ? saved.notificationSoundDataUrl : null,
  notificationSoundName:
    typeof saved.notificationSoundName === "string" ? saved.notificationSoundName : null,

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

  setFontFamilies: (families: string[]) => {
    set({ fontFamilies: families, fontFamily: buildFontStack(families) });
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

  setEnableWebglRenderer: (enabled: boolean) => {
    set({ enableWebglRenderer: enabled });
    saveSettings(get());
  },

  setEnableNotifications: (enabled: boolean) => {
    set({ enableNotifications: enabled });
    saveSettings(get());
  },

  setEnableNotificationSound: (enabled: boolean) => {
    set({ enableNotificationSound: enabled });
    saveSettings(get());
  },

  setNotificationSound: (name: string, dataUrl: string) => {
    set({ notificationSoundName: name, notificationSoundDataUrl: dataUrl });
    saveSettings(get());
  },

  resetNotificationSound: () => {
    set({ notificationSoundName: null, notificationSoundDataUrl: null });
    saveSettings(get());
  },
}));

const saveSettings = (state: SettingsState) => {
  try {
    localStorage.setItem(
      "wmux-settings",
      JSON.stringify({
        fontSize: state.fontSize,
        fontFamilies: state.fontFamilies,
        themeName: state.themeName,
        customColors: state.customColors,
        prefixKey: state.prefixKey,
        enableWebglRenderer: state.enableWebglRenderer,
        enableNotifications: state.enableNotifications,
        enableNotificationSound: state.enableNotificationSound,
        notificationSoundDataUrl: state.notificationSoundDataUrl,
        notificationSoundName: state.notificationSoundName,
      }),
    );
  } catch {}
};
