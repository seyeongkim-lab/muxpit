import { create } from "zustand";
import { THEMES, type CustomColors, type TerminalTheme, type ThemeColorKey, type ThemeEntry } from "../themes.ts";
import { shouldEnableWebglRendererByDefault } from "../utils/runtimePlatform.ts";

export type PrefixKey = "off" | "ctrl+b" | "ctrl+shift+b" | "ctrl+a" | "ctrl+space" | "ctrl+q" | "ctrl+\\";
export type DashboardLayout = "left" | "top";
export type SessionListMetadataKey =
  | "agent"
  | "cwd"
  | "git"
  | "ports"
  | "panes"
  | "process"
  | "memory"
  | "sshTarget"
  | "tmuxSession"
  | "lastCommand";

export type SessionListMetadataSettings = Record<SessionListMetadataKey, boolean>;

export const PREFIX_KEY_CHOICES: { value: PrefixKey; label: string }[] = [
  { value: "ctrl+shift+b", label: "Ctrl+Shift+B" },
  { value: "ctrl+b", label: "Ctrl+B (tmux default)" },
  { value: "ctrl+a", label: "Ctrl+A (screen default)" },
  { value: "ctrl+space", label: "Ctrl+Space" },
  { value: "ctrl+q", label: "Ctrl+Q" },
  { value: "ctrl+\\", label: "Ctrl+\\" },
  { value: "off", label: "Off (disabled)" },
];

export const DASHBOARD_LAYOUT_CHOICES: { value: DashboardLayout; label: string }[] = [
  { value: "left", label: "Left dashboard" },
  { value: "top", label: "Top tabs + files" },
];

export const SESSION_LIST_METADATA_OPTIONS: { key: SessionListMetadataKey; label: string }[] = [
  { key: "agent", label: "Agent" },
  { key: "cwd", label: "CWD" },
  { key: "git", label: "Git branch" },
  { key: "ports", label: "Ports" },
  { key: "panes", label: "Pane count" },
  { key: "process", label: "Process" },
  { key: "memory", label: "Memory" },
  { key: "sshTarget", label: "SSH target" },
  { key: "tmuxSession", label: "Tmux session" },
  { key: "lastCommand", label: "Last command" },
];

const DEFAULT_SESSION_LIST_METADATA: SessionListMetadataSettings = {
  agent: true,
  cwd: false,
  git: true,
  ports: true,
  panes: true,
  process: true,
  memory: false,
  sshTarget: true,
  tmuxSession: true,
  lastCommand: false,
};

interface SettingsState {
  fontSize: number;
  fontFamilies: string[]; // ordered fallback list (source of truth)
  fontFamily: string; // derived CSS/xterm stack string, kept in sync
  themeName: string;
  customColors: CustomColors;
  customThemes: ThemeEntry[];
  prefixKey: PrefixKey;
  dashboardLayout: DashboardLayout;
  enableWebglRenderer: boolean;
  enableNotifications: boolean;
  enableNotificationSound: boolean;
  notificationSoundDataUrl: string | null;
  notificationSoundName: string | null;
  enableExperimentalCwdRestore: boolean;
  enableExperimentalAgentSessionRestore: boolean;
  enableExperimentalAgentDangerousResume: boolean;
  sessionListMetadata: SessionListMetadataSettings;

  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setFontSize: (size: number) => void;
  setFontFamilies: (families: string[]) => void;
  setThemeName: (name: string) => void;
  setCustomColor: (themeName: string, key: ThemeColorKey, color: string) => void;
  resetCustomColors: (themeName: string) => void;
  resetSingleColor: (themeName: string, key: ThemeColorKey) => void;
  addCustomTheme: (name: string, theme: TerminalTheme) => string;
  removeCustomTheme: (name: string) => void;
  setPrefixKey: (key: PrefixKey) => void;
  setDashboardLayout: (layout: DashboardLayout) => void;
  setEnableWebglRenderer: (enabled: boolean) => void;
  setEnableNotifications: (enabled: boolean) => void;
  setEnableNotificationSound: (enabled: boolean) => void;
  setNotificationSound: (name: string, dataUrl: string) => void;
  resetNotificationSound: () => void;
  setEnableExperimentalCwdRestore: (enabled: boolean) => void;
  setEnableExperimentalAgentSessionRestore: (enabled: boolean) => void;
  setEnableExperimentalAgentDangerousResume: (enabled: boolean) => void;
  setSessionListMetadata: (key: SessionListMetadataKey, enabled: boolean) => void;
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
const defaultEnableWebglRenderer = shouldEnableWebglRendererByDefault();
export const storedBoolean = (value: unknown): boolean => value === true;
const storedDashboardLayout = (value: unknown): DashboardLayout =>
  value === "top" ? "top" : "left";
const initialExperimentalAgentSessionRestore =
  storedBoolean(saved.enableExperimentalAgentSessionRestore);

// Resolve the ordered font family list. Prefer the new array model; otherwise
// start from defaults (Sarasa-led CJK). Legacy `fontFamily` stack strings are not
// migrated field-by-field — the ordered list supersedes them.
const savedFamilies: string[] = Array.isArray(saved.fontFamilies)
  ? saved.fontFamilies.filter((f: unknown): f is string => typeof f === "string" && f.length > 0)
  : [];
const initialFamilies = savedFamilies.length > 0 ? savedFamilies : DEFAULT_FONT_FAMILIES;
const isValidThemeEntry = (value: unknown): value is ThemeEntry => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ThemeEntry>;
  return (
    typeof entry.name === "string" &&
    entry.name.trim() !== "" &&
    !!entry.theme &&
    typeof entry.theme === "object"
  );
};

const initialCustomThemes: ThemeEntry[] = Array.isArray(saved.customThemes)
  ? saved.customThemes.filter(isValidThemeEntry)
  : [];

const savedSessionListMetadata: Partial<SessionListMetadataSettings> =
  saved.sessionListMetadata && typeof saved.sessionListMetadata === "object"
    ? saved.sessionListMetadata as Partial<SessionListMetadataSettings>
    : {};
const initialSessionListMetadata: SessionListMetadataSettings = {
  ...DEFAULT_SESSION_LIST_METADATA,
  ...Object.fromEntries(
    (Object.keys(DEFAULT_SESSION_LIST_METADATA) as SessionListMetadataKey[]).map((key) => [
      key,
      typeof savedSessionListMetadata[key] === "boolean"
        ? savedSessionListMetadata[key]
        : DEFAULT_SESSION_LIST_METADATA[key],
    ]),
  ) as SessionListMetadataSettings,
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  fontSize: saved.fontSize ?? 14,
  fontFamilies: initialFamilies,
  fontFamily: buildFontStack(initialFamilies),
  themeName: saved.themeName ?? "Catppuccin Mocha",
  customColors: saved.customColors ?? {},
  customThemes: initialCustomThemes,
  prefixKey: saved.prefixKey ?? "ctrl+shift+b",
  dashboardLayout: storedDashboardLayout(saved.dashboardLayout),
  enableWebglRenderer: saved.enableWebglRenderer ?? defaultEnableWebglRenderer,
  enableNotifications: saved.enableNotifications ?? true,
  enableNotificationSound: saved.enableNotificationSound ?? true,
  notificationSoundDataUrl:
    typeof saved.notificationSoundDataUrl === "string" ? saved.notificationSoundDataUrl : null,
  notificationSoundName:
    typeof saved.notificationSoundName === "string" ? saved.notificationSoundName : null,
  enableExperimentalCwdRestore: storedBoolean(saved.enableExperimentalCwdRestore),
  enableExperimentalAgentSessionRestore: initialExperimentalAgentSessionRestore,
  enableExperimentalAgentDangerousResume: initialExperimentalAgentSessionRestore
    ? storedBoolean(saved.enableExperimentalAgentDangerousResume)
    : false,
  sessionListMetadata: initialSessionListMetadata,

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

  addCustomTheme: (name: string, theme: TerminalTheme) => {
    const trimmed = name.trim() || "Custom theme";
    const taken = new Set([
      ...THEMES.map((t) => t.name),
      ...get().customThemes.map((t) => t.name),
    ]);
    let finalName = trimmed;
    let suffix = 2;
    while (taken.has(finalName)) finalName = `${trimmed} ${suffix++}`;
    set((s) => ({
      customThemes: [...s.customThemes, { name: finalName, theme }],
      themeName: finalName,
    }));
    saveSettings(get());
    return finalName;
  },

  removeCustomTheme: (name: string) => {
    set((s) => {
      if (!s.customThemes.some((t) => t.name === name)) return s;
      const customColors = { ...s.customColors };
      delete customColors[name];
      return {
        customThemes: s.customThemes.filter((t) => t.name !== name),
        customColors,
        themeName: s.themeName === name ? THEMES[0].name : s.themeName,
      };
    });
    saveSettings(get());
  },

  setPrefixKey: (key: PrefixKey) => {
    set({ prefixKey: key });
    saveSettings(get());
  },

  setDashboardLayout: (layout: DashboardLayout) => {
    set({ dashboardLayout: layout });
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

  setEnableExperimentalCwdRestore: (enabled: boolean) => {
    set({ enableExperimentalCwdRestore: enabled });
    saveSettings(get());
  },

  setEnableExperimentalAgentSessionRestore: (enabled: boolean) => {
    set({
      enableExperimentalAgentSessionRestore: enabled,
      enableExperimentalAgentDangerousResume: enabled
        ? get().enableExperimentalAgentDangerousResume
        : false,
    });
    saveSettings(get());
  },

  setEnableExperimentalAgentDangerousResume: (enabled: boolean) => {
    set({
      enableExperimentalAgentDangerousResume:
        get().enableExperimentalAgentSessionRestore && enabled,
    });
    saveSettings(get());
  },

  setSessionListMetadata: (key: SessionListMetadataKey, enabled: boolean) => {
    set((state) => ({
      sessionListMetadata: { ...state.sessionListMetadata, [key]: enabled },
    }));
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
        customThemes: state.customThemes,
        prefixKey: state.prefixKey,
        dashboardLayout: state.dashboardLayout,
        enableWebglRenderer: state.enableWebglRenderer,
        enableNotifications: state.enableNotifications,
        enableNotificationSound: state.enableNotificationSound,
        notificationSoundDataUrl: state.notificationSoundDataUrl,
        notificationSoundName: state.notificationSoundName,
        enableExperimentalCwdRestore: state.enableExperimentalCwdRestore,
        enableExperimentalAgentSessionRestore: state.enableExperimentalAgentSessionRestore,
        enableExperimentalAgentDangerousResume: state.enableExperimentalAgentDangerousResume,
        sessionListMetadata: state.sessionListMetadata,
      }),
    );
  } catch {}
};
