import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../stores/workspace";

interface ClaudeSessionPaneProps {
  id: string;
  sshTarget: string;
  project: string;
  sessionId: string;
}

interface MessageEntry {
  role: "human" | "assistant";
  text: string;
  timestamp?: string;
}

interface JournalEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | { type: string; text?: string }[];
  };
  timestamp?: string;
}

const COLORS = {
  bg: "#1e1e2e",
  surface: "#313244",
  text: "#cdd6f4",
  subtext: "#a6adc8",
  overlay: "#45475a",
  blue: "#89b4fa",
  green: "#a6e3a1",
  red: "#f38ba8",
  mauve: "#cba6f7",
};

const extractText = (content: string | { type: string; text?: string }[] | undefined): string => {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
};

const parseJournalEntries = (raw: string): MessageEntry[] => {
  const messages: MessageEntry[] = [];
  const lines = raw.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const entry: JournalEntry = JSON.parse(line);
      if (entry.type === "human" || entry.type === "assistant") {
        const text = extractText(entry.message?.content);
        if (text) {
          messages.push({
            role: entry.type,
            text,
            timestamp: entry.timestamp,
          });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
};

export const ClaudeSessionPane = ({ id, sshTarget, project, sessionId }: ClaudeSessionPaneProps) => {
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;

    const fetchSession = async () => {
      try {
        setLoading(true);
        setError(null);
        const raw = await invoke<string>("fetch_claude_session", {
          sshTarget,
          project,
          sessionId,
        });
        if (!active) return;
        const parsed = parseJournalEntries(raw);
        setMessages(parsed);
      } catch (err) {
        if (!active) return;
        setError(String(err));
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchSession();
    return () => { active = false; };
  }, [sshTarget, project, sessionId]);

  // Scroll to bottom when messages load
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleClose = useCallback(() => {
    // Find the workspace containing this node and close it
    const state = useWorkspaceStore.getState();
    for (const ws of state.workspaces) {
      const leaves = state.workspaces.length; // just trigger close
      if (leaves) {
        state.closeLeaf(ws.id, id);
        break;
      }
    }
  }, [id]);

  const handleResume = useCallback(() => {
    // Decode projectPath from project name by fetching from store
    // For now use project as-is; the actual projectPath would come from session data
    const cmd = `ssh -t ${sshTarget} "claude --resume ${sessionId}"`;
    useWorkspaceStore.getState().addWorkspace(`Claude: ${project}`, cmd);
  }, [sshTarget, project, sessionId]);

  const projectLabel = project.replace(/-/g, "/");

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>
          {projectLabel} &gt; {sessionId.slice(0, 8)}
        </span>
        <div style={styles.headerBtns}>
          <button style={styles.resumeBtn} onClick={handleResume} title="Resume this session">
            Resume
          </button>
          <button style={styles.closeBtn} onClick={handleClose} title="Close pane">
            x
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={styles.messages}>
        {loading && <div style={styles.status}>Loading session...</div>}
        {error && <div style={styles.error}>Error: {error}</div>}
        {!loading && !error && messages.length === 0 && (
          <div style={styles.status}>No messages found</div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              ...styles.msgBubble,
              ...(msg.role === "human" ? styles.humanBubble : styles.assistantBubble),
            }}
          >
            <div style={styles.msgRole}>
              {msg.role === "human" ? "[User]" : "[Claude]"}
            </div>
            <div style={styles.msgText}>{msg.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: COLORS.bg,
    fontFamily: "'JetBrains Mono', monospace",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    backgroundColor: COLORS.surface,
    borderBottom: `1px solid ${COLORS.overlay}`,
    flexShrink: 0,
  },
  title: {
    color: COLORS.mauve,
    fontSize: 13,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  headerBtns: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    flexShrink: 0,
  },
  resumeBtn: {
    background: COLORS.green,
    border: "none",
    borderRadius: 3,
    color: COLORS.bg,
    fontSize: 11,
    fontWeight: 600,
    padding: "3px 8px",
    cursor: "pointer",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: COLORS.subtext,
    fontSize: 13,
    cursor: "pointer",
    padding: "0 4px",
    lineHeight: 1,
  },
  messages: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "8px 10px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  status: {
    color: COLORS.subtext,
    fontSize: 12,
    textAlign: "center" as const,
    padding: 20,
  },
  error: {
    color: COLORS.red,
    fontSize: 12,
    textAlign: "center" as const,
    padding: 20,
  },
  msgBubble: {
    borderRadius: 6,
    padding: "6px 10px",
    maxWidth: "85%",
    fontSize: 12,
    lineHeight: 1.5,
    wordBreak: "break-word" as const,
  },
  humanBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#1e3a5f",
    color: COLORS.text,
  },
  assistantBubble: {
    alignSelf: "flex-end",
    backgroundColor: COLORS.surface,
    color: COLORS.text,
  },
  msgRole: {
    fontSize: 10,
    fontWeight: 700,
    color: COLORS.subtext,
    marginBottom: 2,
  },
  msgText: {
    whiteSpace: "pre-wrap" as const,
  },
};
