import { useState, useEffect } from "react";
import { useSettingsStore } from "../stores/settings";
import { invoke } from "@tauri-apps/api/core";

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

export const SettingsPanel = ({ open, onClose }: SettingsPanelProps) => {
  const { fontSize, fontFamily, setFontSize, setFontFamily } = useSettingsStore();
  const [allFonts, setAllFonts] = useState<string[]>([]);
  const [monoOnly, setMonoOnly] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (open && allFonts.length === 0) {
      invoke<string[]>("list_fonts").then(setAllFonts).catch(() => {});
    }
  }, [open, allFonts.length]);

  if (!open) return null;

  const displayFonts = allFonts
    .filter((f) => !monoOnly || isLikelyMonospace(f))
    .filter((f) => !search || f.toLowerCase().includes(search.toLowerCase()));

  const currentFontName = fontFamily.match(/^'([^']+)'/)?.[1] ?? fontFamily;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Settings</span>
          <button onClick={onClose} style={styles.closeBtn}>x</button>
        </div>

        <div style={styles.content}>
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

          {/* Font Family */}
          <div style={styles.section}>
            <label style={styles.label}>
              Font Family
              <span style={styles.currentFont}> — {currentFontName}</span>
            </label>
            <div style={styles.filterRow}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fonts..."
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
              {displayFonts.map((font) => (
                <button
                  key={font}
                  onClick={() => setFontFamily(`'${font}', monospace`)}
                  style={{
                    ...styles.fontBtn,
                    ...(currentFontName === font ? styles.fontBtnActive : {}),
                    fontFamily: `'${font}', monospace`,
                  }}
                >
                  {font}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div style={styles.section}>
            <label style={styles.label}>Preview</label>
            <div style={{ ...styles.preview, fontFamily, fontSize }}>
              PS C:\Users\one&gt; git status
              <br />
              abcdefghijklmnopqrstuvwxyz
              <br />
              0123456789 {"=> -> != === {} []"}
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
  value: { color: "#cdd6f4", fontSize: 16, fontWeight: 600, minWidth: 48, textAlign: "center" as const, fontFamily: "monospace" },
  hint: { color: "#585b70", fontSize: 11, marginTop: 4 },
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
  },
  fontBtnActive: { borderColor: "#89b4fa", color: "#cdd6f4", backgroundColor: "#313244" },
  empty: { color: "#585b70", fontSize: 12, padding: 12, textAlign: "center" as const },
  preview: {
    background: "#1e1e2e", border: "1px solid #313244", borderRadius: 4,
    padding: 12, color: "#cdd6f4", lineHeight: 1.5,
  },
};
