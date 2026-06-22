import { useEffect } from "react";
import { FileTreePanel } from "./components/FileTreePanel";
import { applyThemeVars, getResolvedTheme } from "./themes";

export const WebApp = () => {
  useEffect(() => {
    applyThemeVars(getResolvedTheme("Catppuccin Mocha", {}));
  }, []);

  return (
    <div style={styles.container}>
      <div style={styles.titlebar}>
        <div style={styles.brand}>
          <span style={styles.logo}>wmux-server</span>
          <span style={styles.subtitle}>{window.location.host}</span>
        </div>
      </div>
      <main style={styles.body}>
        <FileTreePanel />
      </main>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: "var(--wmux-bg)",
  },
  titlebar: {
    height: 34,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "var(--wmux-bg)",
    borderBottom: "1px solid var(--wmux-hairline)",
    color: "var(--wmux-text)",
    userSelect: "none",
  },
  brand: {
    minWidth: 0,
    height: "100%",
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "0 12px",
  },
  logo: {
    color: "var(--wmux-accent)",
    fontFamily: "var(--wmux-font-display)",
    fontSize: 13,
    fontWeight: 800,
    lineHeight: 1,
  },
  subtitle: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    lineHeight: 1,
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    overflow: "hidden",
  },
};
