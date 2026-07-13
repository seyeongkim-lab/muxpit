import { useCliInstaller } from "../hooks/useCliInstaller";
import { useExperimentalRestoreSettings } from "../hooks/useExperimentalRestoreSettings";
import { useSettingsStore } from "../stores/settings";
import { isMacOsPlatform } from "../utils/runtimePlatform";

export const OnboardingPanel = () => {
  const completed = useSettingsStore((state) => state.hasCompletedOnboarding);
  const setCompleted = useSettingsStore((state) => state.setHasCompletedOnboarding);
  const {
    cwdRestore,
    agentSessionRestore,
    updateCwdRestore,
    updateAgentSessionRestore,
  } = useExperimentalRestoreSettings();
  const { install, installing, status } = useCliInstaller();

  if (completed) return null;

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <div style={styles.header}>
          <div>
            <div style={styles.eyebrow}>AI WORKBENCH SETUP</div>
            <div style={styles.title}>Set up wmux for AI CLI work</div>
          </div>
          <button className="wmux-btn" onClick={() => setCompleted(true)} style={styles.laterButton}>
            Do this later
          </button>
        </div>
        <div style={styles.content}>
          <section style={styles.step}>
            <div style={styles.stepNumber}>1</div>
            <div style={styles.stepBody}>
              <div style={styles.stepTitle}>Install the wmux control CLI</div>
              <div style={styles.description}>AI tools use wmux-cli to split panes, send text, read terminal output, and open the browser pane.</div>
              {isMacOsPlatform() && (
                <div style={styles.actionRow}>
                  <button className="wmux-btn" onClick={install} disabled={installing} style={styles.primaryButton}>
                    {installing ? "Installing..." : "Install wmux-cli"}
                  </button>
                  {status && <span style={styles.status}>{status}</span>}
                </div>
              )}
              {!isMacOsPlatform() && (
                <div style={{ ...styles.description, marginTop: 6 }}>Linux and Windows packages include wmux-cli in the install directory.</div>
              )}
            </div>
          </section>
          <section style={styles.step}>
            <div style={styles.stepNumber}>2</div>
            <div style={styles.stepBody}>
              <div style={styles.stepTitle}>Connect agent hooks</div>
              <div style={styles.description}>Run this once in a wmux terminal. Agent status then appears in Inbox.</div>
              <code style={styles.command}>wmux-cli hooks setup --yes</code>
            </div>
          </section>
          <section style={styles.step}>
            <div style={styles.stepNumber}>3</div>
            <div style={styles.stepBody}>
              <div style={styles.stepTitle}>Choose restore behavior</div>
              <label style={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={cwdRestore}
                  onChange={(event) => updateCwdRestore(event.target.checked)}
                />
                Reopen local terminal panes in their saved directories
              </label>
              <label style={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={agentSessionRestore}
                  onChange={(event) => updateAgentSessionRestore(event.target.checked)}
                />
                Restore saved Codex and Claude sessions
              </label>
              <div style={styles.description}>Approval bypass remains off. It can only be enabled separately in Settings.</div>
            </div>
          </section>
          <section style={styles.shortcutRow}>
            <span><b>AI</b> opens a local agent beside the focused terminal in its current directory.</span>
            <span><b>Inbox</b> shows waiting, done, and error events.</span>
            <span><b>Ctrl+Shift+O</b> opens a browser pane.</span>
          </section>
        </div>
        <div style={styles.footer}>
          <button className="wmux-btn" onClick={() => setCompleted(true)} style={styles.finishButton}>
            Finish setup
          </button>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 130,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.58)",
  },
  panel: {
    width: 680,
    maxWidth: "calc(100vw - 40px)",
    maxHeight: "calc(100vh - 40px)",
    overflow: "auto",
    background: "var(--wmux-bg-elev)",
    border: "1px solid var(--wmux-hairline-strong)",
    boxShadow: "0 18px 56px rgba(0, 0, 0, 0.42)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 20px",
    borderBottom: "1px solid var(--wmux-hairline)",
  },
  eyebrow: { color: "var(--wmux-accent)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em" },
  title: { marginTop: 5, color: "var(--wmux-text)", fontSize: 19, fontWeight: 650 },
  laterButton: { color: "var(--wmux-subtext)", background: "transparent", border: "none", fontSize: 12 },
  content: { padding: "4px 20px" },
  step: { display: "flex", gap: 12, padding: "15px 0", borderBottom: "1px solid var(--wmux-hairline)" },
  stepNumber: {
    width: 24,
    height: 24,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--wmux-text)",
    background: "var(--wmux-bg)",
    border: "1px solid var(--wmux-hairline-strong)",
    fontSize: 11,
  },
  stepBody: { flex: 1, minWidth: 0 },
  stepTitle: { color: "var(--wmux-text)", fontSize: 13, fontWeight: 600, marginBottom: 5 },
  description: { color: "var(--wmux-subtext)", fontSize: 12, lineHeight: 1.5 },
  actionRow: { display: "flex", alignItems: "center", gap: 9, marginTop: 9 },
  primaryButton: {
    padding: "7px 10px",
    color: "var(--wmux-bg)",
    background: "var(--wmux-accent)",
    border: "1px solid var(--wmux-accent)",
  },
  status: { color: "var(--wmux-subtext)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" },
  command: {
    display: "block",
    marginTop: 8,
    padding: "9px 10px",
    color: "var(--wmux-text)",
    background: "var(--wmux-bg)",
    border: "1px solid var(--wmux-hairline)",
    fontFamily: "var(--wmux-font-mono)",
    fontSize: 12,
  },
  checkLabel: { display: "flex", alignItems: "center", gap: 7, marginTop: 8, color: "var(--wmux-text)", fontSize: 12 },
  shortcutRow: { display: "flex", flexDirection: "column", gap: 6, padding: "14px 0", color: "var(--wmux-subtext)", fontSize: 11 },
  footer: { display: "flex", justifyContent: "flex-end", padding: "12px 20px 18px" },
  finishButton: {
    padding: "8px 16px",
    color: "var(--wmux-bg)",
    background: "var(--wmux-accent)",
    border: "1px solid var(--wmux-accent)",
    fontWeight: 600,
  },
};
