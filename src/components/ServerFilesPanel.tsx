import { useCallback, useEffect, useState } from "react";
import {
  buildDownloadUrl,
  getServerToken,
  getSharedWmuxServerClient,
  joinServerPath,
  type ServerDirEntry,
  type ServerDirResponse,
} from "../utils/wmuxServerClient";
import { appInvoke } from "../utils/appBridge";
import type { SshConnection } from "../utils/sshConnection";

type DirState = {
  entries: ServerDirEntry[];
  loading: boolean;
  error: string | null;
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
};

const compactPath = (path: string): string =>
  path
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

interface ServerFilesPanelProps {
  cwd?: string | null;
  // When the active workspace is a tmux/ssh session on another host, its files
  // live there, not on the server. Listing and downloads route over this SSH
  // connection. Absent for local/server-host workspaces.
  sshConnection?: SshConnection | null;
  sshCommand?: string | null;
}

export const ServerFilesPanel = ({ cwd, sshConnection, sshCommand }: ServerFilesPanelProps) => {
  const token = getServerToken();
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState(false);

  const isRemote = !!(sshConnection?.program || (sshCommand && sshCommand.trim()));

  const loadPath = useCallback(
    async (path: string) => {
      if (!token) return;
      const requestPath = path;
      setDirs((prev) => {
        const next = new Map(prev);
        const current = next.get(requestPath);
        next.set(requestPath, {
          entries: current?.entries ?? [],
          loading: true,
          error: null,
        });
        return next;
      });

      try {
        const result: ServerDirResponse = isRemote
          ? await appInvoke<ServerDirResponse>("remote_read_dir", {
              path: requestPath,
              sshConnection: sshConnection ?? null,
              sshCommand: sshCommand ?? null,
            })
          : await getSharedWmuxServerClient().readDir(requestPath);
        setRootPath((prev) => prev ?? result.path);
        setExpanded((prev) => new Set(prev).add(result.path));
        setDirs((prev) => {
          const next = new Map(prev);
          if (requestPath !== result.path) next.delete(requestPath);
          next.set(result.path, {
            entries: result.entries,
            loading: false,
            error: null,
          });
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setDirs((prev) => {
          const next = new Map(prev);
          const current = next.get(requestPath);
          next.set(requestPath, {
            entries: current?.entries ?? [],
            loading: false,
            error: message,
          });
          return next;
        });
      }
    },
    [token, isRemote, sshConnection, sshCommand],
  );

  // Root the tree at the active session's working directory and re-load when the
  // user `cd`s in the terminal (cwd is parsed from the pty stream). Falls back to
  // the server root when no cwd is known. Paths outside the server `--root` come
  // back as a readDir error, which the tree renders in place.
  const requestedRoot = cwd && cwd.trim() ? cwd : "";
  useEffect(() => {
    setDirs(new Map());
    setExpanded(new Set());
    setRootPath(null);
    void loadPath(requestedRoot);
  }, [requestedRoot, loadPath]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!dirs.has(path)) void loadPath(path);
        }
        return next;
      });
    },
    [dirs, loadPath],
  );

  const refresh = useCallback(() => {
    void loadPath(rootPath ?? "");
  }, [loadPath, rootPath]);

  const renderEntry = (parentPath: string, entry: ServerDirEntry, depth: number) => {
    const path = joinServerPath(parentPath, entry.name);
    const isExpanded = expanded.has(path);
    const child = dirs.get(path);

    return (
      <div key={path}>
        <div className="wmux-file-row" style={{ ...styles.row, paddingLeft: 12 + depth * 12 }}>
          <button
            className="wmux-btn"
            onClick={() => entry.isDir && toggleDir(path)}
            style={{ ...styles.expandButton, visibility: entry.isDir ? "visible" : "hidden" }}
            title={entry.isDir ? (isExpanded ? "Collapse folder" : "Expand folder") : undefined}
          >
            {isExpanded ? "▾" : "▸"}
          </button>
          <span style={entry.isDir ? styles.dirMark : styles.fileMark}>{entry.isDir ? "D" : "F"}</span>
          <span style={styles.fileName} title={path}>{entry.name}</span>
          <span style={styles.fileSize}>{entry.isDir ? "" : formatSize(entry.size)}</span>
          <a
            className="wmux-btn"
            href={buildDownloadUrl(path, token, sshConnection)}
            style={styles.download}
            title={entry.isDir ? "Download folder as zip" : "Download file"}
          >
            ↓
          </a>
        </div>
        {entry.isDir && isExpanded && (
          <div>
            {child?.loading && <div style={{ ...styles.status, paddingLeft: 32 + (depth + 1) * 12 }}>loading</div>}
            {child?.error && <div style={{ ...styles.error, paddingLeft: 32 + (depth + 1) * 12 }}>{child.error}</div>}
            {child?.entries.map((childEntry) => renderEntry(path, childEntry, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // Before the root load resolves (or when it errors), `rootPath` is still null
  // but `dirs` is keyed by the requested path — so render off whichever key is
  // live. Without this the panel falls back to `dirs.get("")`, finds nothing for
  // a non-root cwd, and shows a blank screen instead of the loading/error state.
  const activeRootKey = rootPath ?? requestedRoot;
  const root = dirs.get(activeRootKey);

  return (
    <div style={styles.section}>
      <div style={styles.header}>
        <button
          className="wmux-btn"
          onClick={() => setCollapsed((value) => !value)}
          style={styles.foldButton}
          title={collapsed ? "Show files" : "Hide files"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <div style={styles.titleGroup}>
          <span className="wmux-section-label">FILES</span>
          <span style={styles.path} title={rootPath ?? ""}>{rootPath ? compactPath(rootPath) : "server root"}</span>
        </div>
        <button className="wmux-btn" onClick={refresh} style={styles.refresh} title="Refresh files">
          ↻
        </button>
      </div>

      {!collapsed && (
        <div style={styles.tree}>
          {!token && <div style={styles.errorBlock}>missing token</div>}
          {token && root?.loading && <div style={styles.status}>loading</div>}
          {token && root?.error && <div style={styles.errorBlock}>{root.error}</div>}
          {token && root && !root.loading && !root.error && root.entries.length === 0 && (
            <div style={styles.status}>empty</div>
          )}
          {token && root?.entries.map((entry) => renderEntry(activeRootKey, entry, 0))}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  section: {
    borderBottom: "1px solid var(--wmux-hairline)",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    minHeight: 0,
  },
  header: {
    display: "grid",
    gridTemplateColumns: "18px minmax(0, 1fr) 22px",
    alignItems: "center",
    gap: 6,
    padding: "9px 10px 6px 10px",
  },
  titleGroup: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  path: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  foldButton: {
    width: 18,
    height: 20,
    border: "none",
    background: "transparent",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: 0,
    fontSize: 12,
  },
  refresh: {
    width: 22,
    height: 22,
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: 0,
    fontSize: 12,
  },
  tree: {
    maxHeight: "18vh",
    minHeight: 64,
    overflow: "auto",
    padding: "0 0 6px",
  },
  row: {
    minHeight: 25,
    display: "grid",
    gridTemplateColumns: "16px 14px minmax(0, 1fr) 44px 24px",
    alignItems: "center",
    gap: 5,
    paddingRight: 8,
    color: "var(--wmux-text)",
    fontSize: 11,
  },
  expandButton: {
    width: 16,
    height: 20,
    border: "none",
    background: "transparent",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: 0,
    fontSize: 12,
  },
  dirMark: {
    color: "var(--wmux-accent)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    fontWeight: 700,
  },
  fileMark: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    fontWeight: 700,
  },
  fileName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileSize: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "right",
  },
  download: {
    width: 21,
    height: 21,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-subtext)",
    textDecoration: "none",
    fontSize: 12,
  },
  status: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    padding: "6px 12px",
  },
  error: {
    color: "#f38ba8",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    padding: "6px 12px",
  },
  errorBlock: {
    color: "#f38ba8",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    padding: "6px 12px",
  },
};
