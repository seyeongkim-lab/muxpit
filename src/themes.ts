export interface ThemeEntry {
  name: string;
  theme: TerminalTheme;
}

export interface TerminalTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
  extendedAnsi?: string[];
}

export const THEMES: ThemeEntry[] = [
  {
    name: "Catppuccin Mocha",
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#cba6f7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#cba6f7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    name: "Dracula",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    name: "Tokyo Night",
    theme: {
      background: "#1a1b26",
      foreground: "#a9b1d6",
      cursor: "#c0caf5",
      selectionBackground: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    name: "Nord",
    theme: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    name: "Gruvbox Dark",
    theme: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    name: "One Dark",
    theme: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      selectionBackground: "#3e4451",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
];

export const getThemeByName = (name: string): ThemeEntry =>
  THEMES.find((t) => t.name === name) ?? THEMES[0];

// Only string-valued theme keys (excludes extendedAnsi which is string[])
export type ThemeColorKey = Exclude<{
  [K in keyof TerminalTheme]: TerminalTheme[K] extends string | undefined ? K : never;
}[keyof TerminalTheme], undefined>;

export const THEME_COLOR_GROUPS: { label: string; keys: ThemeColorKey[] }[] = [
  {
    label: "Main",
    keys: ["background", "foreground", "cursor", "selectionBackground"],
  },
  {
    label: "Standard",
    keys: ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"],
  },
  {
    label: "Bright",
    keys: ["brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"],
  },
];

export type CustomColors = Record<string, Partial<Record<ThemeColorKey, string>>>;

export const getResolvedTheme = (name: string, customColors: CustomColors): TerminalTheme => {
  const base = getThemeByName(name).theme;
  const overrides = customColors[name];
  if (!overrides) return base;
  return { ...base, ...overrides };
};

// --- Chrome theming helpers ---------------------------------------------

/** Parse `#rrggbb` (or short `#rgb`) to `[r,g,b]`. Returns black on bad input. */
const parseHex = (hex: string): [number, number, number] => {
  let m = hex.replace("#", "");
  if (m.length === 3) m = m.split("").map((c) => c + c).join("");
  if (m.length !== 6) return [0, 0, 0];
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
};

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

const hexToRgba = (hex: string, alpha: number): string => {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Mix the colour towards black. factor=0 returns input, factor=1 returns black. */
const darken = (hex: string, factor: number): string => {
  const [r, g, b] = parseHex(hex);
  return toHex(r * (1 - factor), g * (1 - factor), b * (1 - factor));
};

/**
 * Push the resolved xterm theme onto `:root` as CSS custom properties so the
 * chrome (sidebar, toolbars, cards) automatically follows whichever theme the
 * user has picked. The sidebar bg is deliberately darker than the terminal
 * bg so the two surfaces read as separate planes — terminal is content,
 * sidebar is chrome.
 */
export const applyThemeVars = (theme: TerminalTheme): void => {
  const root = document.documentElement;
  const bg = theme.background ?? "#1e1e2e";
  const accent = theme.blue ?? "#89b4fa";
  const accent2 = theme.magenta ?? "#cba6f7";
  const text = theme.foreground ?? "#cdd6f4";
  const subtext = theme.brightBlack ?? "#6c7086";

  root.style.setProperty("--wmux-bg", darken(bg, 0.4));
  root.style.setProperty("--wmux-bg-soft", bg);
  root.style.setProperty("--wmux-bg-elev", "rgba(255, 255, 255, 0.025)");
  root.style.setProperty("--wmux-text", text);
  root.style.setProperty("--wmux-subtext", subtext);
  root.style.setProperty("--wmux-hairline", "rgba(255, 255, 255, 0.06)");
  root.style.setProperty("--wmux-hairline-strong", "rgba(255, 255, 255, 0.10)");
  root.style.setProperty("--wmux-accent", accent);
  root.style.setProperty("--wmux-accent-2", accent2);
  root.style.setProperty("--wmux-accent-soft", hexToRgba(accent, 0.07));
  root.style.setProperty("--wmux-accent-mid", hexToRgba(accent, 0.18));
  root.style.setProperty("--wmux-accent-strong", hexToRgba(accent, 0.55));
  root.style.setProperty("--wmux-accent-glow", hexToRgba(accent, 0.35));
  root.style.setProperty("--wmux-accent-2-soft", hexToRgba(accent2, 0.08));
};
