import { AI_KINDS, AI_LABEL } from "../stores/aiCli";
import type { AiKind } from "../stores/workspace";

interface SidebarAiPanelProps {
  sshTarget: string;
  available: Set<AiKind> | undefined;
  probing: boolean;
  onOpenAiPane?: (kind: AiKind) => void;
}

export const SidebarAiPanel = ({ sshTarget, available, probing, onOpenAiPane }: SidebarAiPanelProps) => {
  const candidates = AI_KINDS.filter((kind) => available?.has(kind));
  const status = probing ? "probing" : available ? `${candidates.length}` : "pending";

  return (
    <div className="wmux-card" style={styles.container}>
      <div style={styles.header}>
        <div style={styles.titleGroup}>
          <span className="wmux-section-label">AI</span>
          <span style={styles.target} title={sshTarget}>{sshTarget}</span>
        </div>
        <span style={styles.status}>{status}</span>
      </div>

      {candidates.length > 0 ? (
        <div style={styles.buttons}>
          {candidates.map((kind) => (
            <button
              key={kind}
              className="wmux-ai-btn"
              style={styles.aiButton}
              onClick={() => onOpenAiPane?.(kind)}
              title={`Open ${AI_LABEL[kind]} pane`}
            >
              {AI_LABEL[kind]}
            </button>
          ))}
        </div>
      ) : (
        <div style={styles.empty}>{probing ? "checking" : available ? "none" : "waiting"}</div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "6px 8px 7px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  titleGroup: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  target: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
  },
  status: {
    color: "var(--wmux-accent)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    flexShrink: 0,
  },
  buttons: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  aiButton: {
    borderRadius: 6,
    padding: "2px 8px 3px",
  },
  empty: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
  },
};
