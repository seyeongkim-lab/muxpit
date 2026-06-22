import { useState, useEffect, useCallback, useRef } from "react";
import { useSettingsStore, PREFIX_KEY_CHOICES, SESSION_LIST_METADATA_OPTIONS, type PrefixKey } from "../stores/settings";
import { useWorkspaceStore } from "../stores/workspace";
import { THEMES, THEME_COLOR_GROUPS, getThemeByName, getResolvedTheme } from "../themes";
import type { ThemeColorKey } from "../themes";
import { playNotificationSound } from "../utils/notificationSound";
import { isMacOsPlatform } from "../utils/runtimePlatform";
import { appInvoke } from "../utils/appBridge";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

const MONO_HINTS = [
  "mono", "code", "consol", "hack", "fira", "source", "jetbrains",
  "cascadia", "d2coding", "nanum", "menlo", "courier", "iosevka",
  "inconsolata", "ubuntu mono", "roboto mono", "ibm plex mono",
  "fantasque", "victor", "geist mono", "sarasa",
];

const isLikelyMonospace = (name: string) => {
  const lower = name.toLowerCase();
  return MONO_HINTS.some((h) => lower.includes(h));
};

const COLOR_LABELS: Partial<Record<ThemeColorKey, string>> = {
  background: "BG", foreground: "FG", cursor: "Cursor", selectionBackground: "Selection",
  black: "Black", red: "Red", green: "Green", yellow: "Yellow",
  blue: "Blue", magenta: "Magenta", cyan: "Cyan", white: "White",
  brightBlack: "Bright Black", brightRed: "Bright Red", brightGreen: "Bright Green",
  brightYellow: "Bright Yellow", brightBlue: "Bright Blue", brightMagenta: "Bright Magenta",
  brightCyan: "Bright Cyan", brightWhite: "Bright White",
};

const ColorSwatch = ({
  colorKey, currentColor, isCustomized, onChange, onReset,
}: {
  colorKey: ThemeColorKey; currentColor: string; isCustomized: boolean;
  onChange: (key: ThemeColorKey, color: string) => void;
  onReset: (key: ThemeColorKey) => void;
}) => {
  return (
    <div style={styles.swatchContainer}>
      <div style={styles.swatchWrap}>
        <div
          style={{ ...styles.swatch, backgroundColor: currentColor, ...(isCustomized ? styles.swatchCustomized : {}) }}
        />
        <input
          type="color"
          value={currentColor}
          onChange={(e) => onChange(colorKey, e.target.value)}
          style={styles.colorInput}
          title={`${COLOR_LABELS[colorKey] ?? colorKey}: ${currentColor}`}
        />
      </div>
      <span style={{ ...styles.swatchLabel, ...(isCustomized ? { color: "#f9e2af" } : {}) }}>
        {COLOR_LABELS[colorKey] ?? colorKey}
      </span>
      {isCustomized && (
        <button onClick={() => onReset(colorKey)} style={styles.swatchReset} title="Reset to default">
          x
        </button>
      )}
    </div>
  );
};

export const SettingsPanel = ({ open, onClose }: SettingsPanelProps) => {
  const {
    fontSize,
    fontFamily,
    fontFamilies,
    themeName,
    customColors,
    prefixKey,
    enableWebglRenderer,
    enableNotifications,
    enableNotificationSound,
    notificationSoundName,
    enableExperimentalCwdRestore,
    enableExperimentalAgentSessionRestore,
    enableExperimentalAgentDangerousResume,
    sessionListMetadata,
    setFontSize, setFontFamilies, setThemeName, setCustomColor, resetCustomColors, resetSingleColor, setPrefixKey,
    setEnableWebglRenderer,
    setEnableNotifications,
    setEnableNotificationSound,
    setNotificationSound,
    resetNotificationSound,
    setEnableExperimentalCwdRestore,
    setEnableExperimentalAgentSessionRestore,
    setEnableExperimentalAgentDangerousResume,
    setSessionListMetadata,
  } = useSettingsStore();
  const [allFonts, setAllFonts] = useState<string[]>([]);
  const [monoOnly, setMonoOnly] = useState(true);
  const [search, setSearch] = useState("");
  const [colorOpen, setColorOpen] = useState(false);
  const [cliInstallStatus, setCliInstallStatus] = useState<string | null>(null);
  const [cliInstalling, setCliInstalling] = useState(false);
  const soundInputRef = useRef<HTMLInputElement | null>(null);

  const baseTheme = getThemeByName(themeName).theme;
  const resolvedTheme = getResolvedTheme(themeName, customColors);
  const themeOverrides = customColors[themeName] ?? {};
  const hasCustomizations = Object.keys(themeOverrides).length > 0;

  const handleColorChange = useCallback(
    (key: ThemeColorKey, color: string) => setCustomColor(themeName, key, color),
    [themeName, setCustomColor],
  );

  const handleColorReset = useCallback(
    (key: ThemeColorKey) => resetSingleColor(themeName, key),
    [themeName, resetSingleColor],
  );

  const handleExperimentalCwdRestoreChange = useCallback(
    (enabled: boolean) => {
      setEnableExperimentalCwdRestore(enabled);
      if (!enabled) {
        useWorkspaceStore.getState().clearSavedCwd();
      }
    },
    [setEnableExperimentalCwdRestore],
  );

  const handleExperimentalAgentSessionRestoreChange = useCallback(
    (enabled: boolean) => {
      setEnableExperimentalAgentSessionRestore(enabled);
      if (!enabled) {
        setEnableExperimentalAgentDangerousResume(false);
        useWorkspaceStore.getState().clearSavedAgentSessions();
      }
    },
    [setEnableExperimentalAgentDangerousResume, setEnableExperimentalAgentSessionRestore],
  );

  useEffect(() => {
    if (open && allFonts.length === 0) {
      appInvoke<string[]>("list_fonts").then(setAllFonts).catch(() => {});
    }
  }, [open, allFonts.length]);

  const installCli = useCallback(async () => {
    setCliInstalling(true);
    setCliInstallStatus(null);
    try {
      const path = await appInvoke<string>("install_cli_symlink");
      setCliInstallStatus(`Installed at ${path}`);
    } catch (error) {
      setCliInstallStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setCliInstalling(false);
    }
  }, []);

  if (!open) return null;

  const displayFonts = allFonts
    .filter((f) => !monoOnly || isLikelyMonospace(f))
    .filter((f) => !search || f.toLowerCase().includes(search.toLowerCase()));

  const addFont = (f: string) => {
    if (!fontFamilies.includes(f)) setFontFamilies([...fontFamilies, f]);
  };
  const removeFont = (f: string) => setFontFamilies(fontFamilies.filter((x) => x !== f));
  const moveFont = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= fontFamilies.length) return;
    const next = [...fontFamilies];
    [next[i], next[j]] = [next[j], next[i]];
    setFontFamilies(next);
  };

  const chooseSoundFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setNotificationSound(file.name, reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Settings</span>
          <button onClick={onClose} style={styles.closeBtn}>x</button>
        </div>

        <div style={styles.content}>
          {isMacOsPlatform() && (
            <div style={styles.section}>
              <label style={styles.label}>Command Line</label>
              <div style={styles.row}>
                <button
                  onClick={installCli}
                  style={styles.btn}
                  disabled={cliInstalling}
                >
                  {cliInstalling ? "Installing..." : "Install CLI"}
                </button>
                {cliInstallStatus && (
                  <span style={styles.inlineStatus}>{cliInstallStatus}</span>
                )}
              </div>
              <div style={styles.hint}>Creates ~/.local/bin/wmux-cli for terminal use.</div>
            </div>
          )}

          {/* Font Size */}
          <div style={styles.section}>
            <label style={styles.label}>Font Size</label>
            <div style={styles.row}>
              <button onClick={() => setFontSize(fontSize - 1)} style={styles.btn}>-</button>
              <span style={styles.value}>{fontSize}px</span>
              <button onClick={() => setFontSize(fontSize + 1)} style={styles.btn}>+</button>
              <button onClick={() => setFontSize(14)} style={styles.resetBtn}>Reset</button>
            </div>
            <div style={styles.hint}>Ctrl+= / Ctrl+- / Ctrl+0</div>
          </div>

          {/* Terminal Renderer */}
          <div style={styles.section}>
            <label style={styles.label}>Terminal Renderer</label>
            <label style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={enableWebglRenderer}
                onChange={(e) => setEnableWebglRenderer(e.target.checked)}
              />
              Enable WebGL renderer
            </label>
            <div style={styles.hint}>Disable if terminal input appears delayed.</div>
          </div>

          {/* Notifications */}
          <div style={styles.section}>
            <label style={styles.label}>Notifications</label>
            <label style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={enableNotifications}
                onChange={(e) => setEnableNotifications(e.target.checked)}
              />
              Enable notification badge and system notifications
            </label>
            <div style={styles.soundControls}>
              <label style={{ ...styles.checkLabel, opacity: enableNotifications ? 1 : 0.5 }}>
                <input
                  type="checkbox"
                  checked={enableNotificationSound}
                  disabled={!enableNotifications}
                  onChange={(e) => setEnableNotificationSound(e.target.checked)}
                />
                Play sound
              </label>
              <button
                onClick={() => soundInputRef.current?.click()}
                style={styles.smallBtn}
              >
                Choose File
              </button>
              <button
                onClick={playNotificationSound}
                style={styles.smallBtn}
                disabled={!enableNotificationSound}
              >
                Test
              </button>
              {notificationSoundName && (
                <button
                  onClick={resetNotificationSound}
                  style={styles.smallBtn}
                >
                  Default
                </button>
              )}
            </div>
            <input
              ref={soundInputRef}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={(e) => {
                chooseSoundFile(e.currentTarget.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
            <div style={styles.soundName}>{notificationSoundName ?? "Default bell"}</div>
            <div style={styles.hint}>Turn off Play sound to mute notification audio.</div>
          </div>

          {/* Session List */}
          <div style={styles.section}>
            <label style={styles.label}>Session List</label>
            <div style={styles.metadataGrid}>
              {SESSION_LIST_METADATA_OPTIONS.map((option) => (
                <label key={option.key} style={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={sessionListMetadata[option.key]}
                    onChange={(e) => setSessionListMetadata(option.key, e.target.checked)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <div style={styles.hint}>SSH sessions show only local routing metadata such as target, panes, and tmux session.</div>
          </div>

          {/* Experimental */}
          <div style={styles.section}>
            <label style={styles.label}>Experimental</label>
            <label style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={enableExperimentalCwdRestore}
                onChange={(e) => handleExperimentalCwdRestoreChange(e.target.checked)}
              />
              Restore local session CWD
            </label>
            <div style={styles.hint}>
              Stores local pane directories and reopens them there. SSH and tmux panes are excluded.
            </div>
            <label style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={enableExperimentalAgentSessionRestore}
                onChange={(e) => handleExperimentalAgentSessionRestoreChange(e.target.checked)}
              />
              Restore Codex and Claude sessions
            </label>
            <div style={styles.hint}>
              Stores wmux-launched Codex and Claude session IDs and directories in local app storage.
            </div>
            <label style={{ ...styles.checkLabel, opacity: enableExperimentalAgentSessionRestore ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={enableExperimentalAgentDangerousResume}
                disabled={!enableExperimentalAgentSessionRestore}
                onChange={(e) => setEnableExperimentalAgentDangerousResume(e.target.checked)}
              />
              Resume agents without approvals or sandbox
            </label>
            <div style={styles.hint}>
              Uses Codex and Claude dangerous bypass flags only when restoring saved agent sessions.
            </div>
          </div>

          {/* Prefix Key (tmux-style) */}
          <div style={styles.section}>
            <label style={styles.label}>Prefix Key</label>
            <select
              value={prefixKey}
              onChange={(e) => setPrefixKey(e.target.value as PrefixKey)}
              style={styles.select}
            >
              {PREFIX_KEY_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <div style={styles.hint}>
              After prefix: arrows focus, Ctrl+arrows resize, Space cycles layout,
              " / % split, x close, z zoom, o next, c new, n/p workspace, 0-9 select,
              q numbers, ! break, h history
            </div>
          </div>

          {/* Theme */}
          <div style={styles.section}>
            <label style={styles.label}>Theme</label>
            <div style={styles.themeGrid}>
              {THEMES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => setThemeName(t.name)}
                  style={{
                    ...styles.themeBtn,
                    ...(themeName === t.name ? styles.themeBtnActive : {}),
                  }}
                >
                  <div style={styles.themePreview}>
                    {[t.theme.red, t.theme.green, t.theme.yellow, t.theme.blue, t.theme.magenta, t.theme.cyan].map(
                      (color, i) => (
                        <span
                          key={i}
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            backgroundColor: color as string,
                          }}
                        />
                      ),
                    )}
                  </div>
                  <span style={{ ...styles.themeName, color: t.theme.foreground as string }}>
                    {t.name}
                  </span>
                  <span
                    style={{
                      ...styles.themeBg,
                      backgroundColor: t.theme.background as string,
                    }}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Custom Colors */}
          <div style={styles.section}>
            <div style={styles.colorHeader}>
              <button
                onClick={() => setColorOpen(!colorOpen)}
                style={styles.colorToggle}
              >
                <span style={{ transform: colorOpen ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform 0.15s" }}>
                  ▸
                </span>
                {" "}Customize Colors
                {hasCustomizations && (
                  <span style={styles.customBadge}>{Object.keys(themeOverrides).length} customized</span>
                )}
              </button>
              {hasCustomizations && (
                <button onClick={() => resetCustomColors(themeName)} style={styles.resetAllBtn}>
                  Reset All
                </button>
              )}
            </div>
            {colorOpen && (
              <div style={styles.colorPanel}>
                {THEME_COLOR_GROUPS.map((group) => (
                  <div key={group.label} style={styles.colorGroup}>
                    <span style={styles.colorGroupLabel}>{group.label}</span>
                    <div style={styles.swatchGrid}>
                      {group.keys.map((key) => (
                        <ColorSwatch
                          key={key}
                          colorKey={key}
                          currentColor={(resolvedTheme[key] as string) ?? (baseTheme[key] as string) ?? "#000000"}
                          isCustomized={key in themeOverrides}
                          onChange={handleColorChange}
                          onReset={handleColorReset}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Font Family — ordered fallback list (top = highest priority) */}
          <div style={styles.section}>
            <label style={styles.label}>
              Font Family
              <span style={styles.currentFont}> — fallback order, top first</span>
            </label>
            <div style={styles.selectedList}>
              {fontFamilies.length === 0 && (
                <div style={styles.empty}>No fonts selected — add from the list below</div>
              )}
              {fontFamilies.map((f, i) => (
                <div key={f} style={styles.selectedRow}>
                  <span style={styles.orderNum}>{i + 1}</span>
                  <span style={{ ...styles.selectedName, fontFamily: `'${f}', monospace` }}>{f}</span>
                  <button
                    className="wmux-btn"
                    style={styles.iconBtn}
                    disabled={i === 0}
                    onClick={() => moveFont(i, -1)}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    className="wmux-btn"
                    style={styles.iconBtn}
                    disabled={i === fontFamilies.length - 1}
                    onClick={() => moveFont(i, 1)}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    className="wmux-btn"
                    style={styles.iconBtn}
                    onClick={() => removeFont(f)}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div style={styles.filterRow}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Add a font — search..."
                style={styles.input}
              />
              <label style={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={monoOnly}
                  onChange={(e) => setMonoOnly(e.target.checked)}
                />
                Mono only
              </label>
            </div>
            <div style={styles.fontList}>
              {displayFonts.length === 0 && (
                <div style={styles.empty}>
                  {allFonts.length === 0 ? "Loading fonts..." : "No fonts found"}
                </div>
              )}
              {displayFonts.map((font) => {
                const selected = fontFamilies.includes(font);
                return (
                  <button
                    key={font}
                    onClick={() => (selected ? removeFont(font) : addFont(font))}
                    style={{
                      ...styles.fontBtn,
                      ...(selected ? styles.fontBtnActive : {}),
                      fontFamily: `'${font}', monospace`,
                    }}
                  >
                    <span style={styles.fontBtnMark}>{selected ? "✓" : "+"}</span>
                    {font}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Preview */}
          <div style={styles.section}>
            <label style={styles.label}>Preview</label>
            <div style={{
              ...styles.preview, fontFamily, fontSize,
              background: resolvedTheme.background as string,
              color: resolvedTheme.foreground as string,
            }}>
              <span>PS C:\dev&gt; git status</span>
              <br />
              <span style={{ color: resolvedTheme.green as string }}>abcdefghijklmnopqrstuvwxyz</span>
              <br />
              <span style={{ color: resolvedTheme.yellow as string }}>0123456789</span>
              {" "}
              <span style={{ color: resolvedTheme.blue as string }}>{"=> -> != === {} []"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    zIndex: 100,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  panel: {
    width: 440,
    maxHeight: "85vh",
    backgroundColor: "#181825",
    border: "1px solid #313244",
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #313244",
  },
  title: { color: "#cdd6f4", fontSize: 14, fontWeight: 600 },
  closeBtn: { background: "none", border: "none", color: "#a6adc8", fontSize: 16, cursor: "pointer" },
  content: { padding: 16, overflowY: "auto" as const, flex: 1 },
  section: { marginBottom: 20 },
  label: { color: "#a6adc8", fontSize: 12, fontWeight: 600, display: "block", marginBottom: 8 },
  currentFont: { color: "#89b4fa", fontWeight: 400 },
  row: { display: "flex", alignItems: "center", gap: 8 },
  btn: {
    background: "#313244", border: "1px solid #45475a", borderRadius: 4,
    color: "#cdd6f4", fontSize: 13, padding: "4px 12px", cursor: "pointer",
  },
  resetBtn: {
    background: "none", border: "1px solid #45475a", borderRadius: 4,
    color: "#a6adc8", fontSize: 11, padding: "4px 8px", cursor: "pointer", marginLeft: 8,
  },
  smallBtn: {
    background: "#313244", border: "1px solid #45475a", borderRadius: 4,
    color: "#cdd6f4", fontSize: 11, padding: "4px 8px", cursor: "pointer",
  },
  value: { color: "#cdd6f4", fontSize: 16, fontWeight: 600, minWidth: 48, textAlign: "center" as const, fontFamily: "monospace" },
  hint: { color: "#585b70", fontSize: 11, marginTop: 4 },
  inlineStatus: {
    color: "#89b4fa", fontSize: 11, overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
  },
  soundControls: { display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" as const },
  soundName: {
    color: "#89b4fa", fontSize: 11, marginTop: 6,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
  },
  metadataGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "6px 12px",
  },
  select: {
    width: "100%", background: "#313244", border: "1px solid #45475a", borderRadius: 4,
    color: "#cdd6f4", fontSize: 13, padding: "6px 10px", outline: "none", cursor: "pointer",
  },
  filterRow: { display: "flex", gap: 8, marginBottom: 8, alignItems: "center" },
  input: {
    flex: 1, background: "#313244", border: "1px solid #45475a", borderRadius: 4,
    color: "#cdd6f4", fontSize: 12, padding: "4px 8px", outline: "none",
  },
  checkLabel: { color: "#a6adc8", fontSize: 11, display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" as const },
  fontList: { maxHeight: 200, overflowY: "auto" as const, display: "flex", flexDirection: "column" as const, gap: 2 },
  fontBtn: {
    background: "#1e1e2e", border: "1px solid transparent", borderRadius: 4,
    color: "#a6adc8", fontSize: 13, padding: "6px 12px", cursor: "pointer", textAlign: "left" as const,
    display: "flex", alignItems: "center", gap: 8,
  },
  fontBtnActive: { borderColor: "#89b4fa", color: "#cdd6f4", backgroundColor: "#313244" },
  fontBtnMark: { color: "#89b4fa", fontSize: 12, width: 12, flexShrink: 0, textAlign: "center" as const },
  selectedList: { display: "flex", flexDirection: "column" as const, gap: 3, marginBottom: 10 },
  selectedRow: {
    display: "flex", alignItems: "center", gap: 6,
    background: "#181825", border: "1px solid #313244", borderRadius: 4, padding: "4px 6px",
  },
  orderNum: { color: "#585b70", fontSize: 11, width: 16, flexShrink: 0, textAlign: "center" as const, fontFamily: "monospace" },
  selectedName: { flex: 1, color: "#cdd6f4", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  iconBtn: {
    background: "none", border: "none", color: "#a6adc8", cursor: "pointer",
    fontSize: 12, padding: "2px 5px", flexShrink: 0, lineHeight: 1, borderRadius: 3,
  },
  themeGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  themeBtn: {
    position: "relative" as const, overflow: "hidden",
    background: "#1e1e2e", border: "1px solid transparent", borderRadius: 6,
    padding: "8px 10px", cursor: "pointer", display: "flex", flexDirection: "column" as const, gap: 4, textAlign: "left" as const,
  },
  themeBtnActive: { borderColor: "#89b4fa" },
  themePreview: { display: "flex", gap: 3 },
  themeName: { fontSize: 11, fontWeight: 500 },
  themeBg: { position: "absolute" as const, inset: 0, zIndex: -1, borderRadius: 6 },
  empty: { color: "#585b70", fontSize: 12, padding: 12, textAlign: "center" as const },
  preview: {
    background: "#1e1e2e", border: "1px solid #313244", borderRadius: 4,
    padding: 12, color: "#cdd6f4", lineHeight: 1.5,
  },
  // Color customization styles
  colorHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
  },
  colorToggle: {
    background: "none", border: "none", color: "#a6adc8", fontSize: 12,
    fontWeight: 600, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6,
  },
  customBadge: {
    fontSize: 10, color: "#f9e2af", background: "rgba(249,226,175,0.1)",
    borderRadius: 8, padding: "1px 6px", marginLeft: 6,
  },
  resetAllBtn: {
    background: "none", border: "1px solid #45475a", borderRadius: 4,
    color: "#f38ba8", fontSize: 10, padding: "2px 8px", cursor: "pointer",
  },
  colorPanel: {
    marginTop: 10, display: "flex", flexDirection: "column" as const, gap: 12,
  },
  colorGroup: {},
  colorGroupLabel: {
    color: "#585b70", fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const,
    letterSpacing: 1, display: "block", marginBottom: 6,
  },
  swatchGrid: {
    display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6,
  },
  swatchContainer: {
    display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 2, position: "relative" as const,
  },
  swatchWrap: {
    position: "relative" as const, width: 28, height: 28,
  },
  swatch: {
    width: 28, height: 28, borderRadius: 4, border: "1px solid #45475a",
  },
  swatchCustomized: {
    borderColor: "#f9e2af", borderWidth: 2,
  },
  colorInput: {
    position: "absolute" as const, top: 0, left: 0, width: 28, height: 28,
    opacity: 0, cursor: "pointer",
  },
  swatchLabel: {
    fontSize: 8, color: "#585b70", textAlign: "center" as const, lineHeight: 1,
    maxWidth: 48, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const,
  },
  swatchReset: {
    position: "absolute" as const, top: -4, right: -2, width: 12, height: 12,
    borderRadius: "50%", background: "#45475a", border: "none", color: "#cdd6f4",
    fontSize: 8, lineHeight: "12px", textAlign: "center" as const, cursor: "pointer", padding: 0,
  },
};
