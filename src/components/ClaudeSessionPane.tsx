import { useEffect, useState, useRef, useCallback } from "react";
import { useWorkspaceStore } from "../stores/workspace";
import { buildClaudeResumeRemoteCommand } from "../utils/claudeSession";
import {
  buildSshCommandWithRemoteCmdFromConnection,
  parseSshCommandLine,
  type SshConnection,
} from "../utils/sshConnection";
import { appInvoke, appListen } from "../utils/appBridge";

interface ClaudeSessionPaneProps {
  id: string;
  sshTarget: string;
  sshConnection?: SshConnection;
  project: string;
  projectPath?: string;
  sessionId: string;
  monitorId: string;
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

const parseJournalEntries = (raw: string | string[]): MessageEntry[] => {
  const messages: MessageEntry[] = [];
  const lines = Array.isArray(raw) ? raw : raw.split("\n");
  const filtered = lines.filter((l) => l.trim());

  for (const line of filtered) {
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

export const ClaudeSessionPane = ({ id, sshTarget, sshConnection, project, projectPath, sessionId, monitorId }: ClaudeSessionPaneProps) => {
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef<string>("");

  // Request session content via monitor's SSH connection
  useEffect(() => {
    let active = true;
    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    requestIdRef.current = reqId;

    setLoading(true);
    setError(null);

    // Listen for response
    const unlisten = appListen<{ request_id: string; lines: string[]; error: string | null }>(
      "claude-session-content",
      (payload) => {
        if (!active || payload.request_id !== reqId) return;
        if (payload.error) {
          setError(payload.error);
        } else {
          const parsed = parseJournalEntries(payload.lines);
          setMessages(parsed);
        }
        setLoading(false);
      },
    );

    // Send request through monitor's SSH connection
    appInvoke("request_session_content", {
      monitorId,
      project,
      sessionId,
      requestId: reqId,
    }).catch((err) => {
      if (active) {
        setError(String(err));
        setLoading(false);
      }
    });

    return () => {
      active = false;
      unlisten.then((fn) => fn());
    };
  }, [monitorId, project, sessionId]);

  // Scroll to bottom when messages load
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleClose = useCallback(() => {
    const state = useWorkspaceStore.getState();
    const activeId = state.activeId;
    if (activeId) {
      state.closeLeaf(activeId, id);
    }
  }, [id]);

  const handleResume = useCallback(() => {
    const connection = sshConnection ?? parseSshCommandLine(`ssh ${sshTarget}`)?.connection;
    const remote = buildClaudeResumeRemoteCommand(projectPath, sessionId);
    const cmd = connection
      ? buildSshCommandWithRemoteCmdFromConnection(connection, remote, true)
      : undefined;
    useWorkspaceStore.getState().addWorkspace(`Claude: ${project}`, cmd, undefined, connection, remote);
  }, [sshTarget, sshConnection, project, projectPath, sessionId]);

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
