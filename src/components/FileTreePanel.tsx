import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildDownloadUrl,
  getServerToken,
  joinServerPath,
  type ServerDirEntry,
  type ServerDirResponse,
  WmuxServerClient,
} from "../utils/wmuxServerClient";

type DirState = {
  entries: ServerDirEntry[];
  loading: boolean;
  error: string | null;
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
};

const formatMtime = (mtime: number | null): string => {
  if (!mtime) return "";
  return new Date(mtime * 1000).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const FileTreePanel = () => {
  const token = getServerToken();
  const client = useMemo(() => new WmuxServerClient(token), [token]);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const loadPath = useCallback(
    async (path: string) => {
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
        const result: ServerDirResponse = await client.readDir(requestPath);
        setRootPath((prev) => prev ?? result.path);
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(result.path);
          return next;
        });
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
    [client],
  );

  useEffect(() => {
    if (!token) return;
    void loadPath("");
    return () => client.close();
  }, [client, loadPath, token]);

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
        <div className="wmux-file-row" style={{ ...styles.row, paddingLeft: 14 + depth * 18 }}>
          <button
            className="wmux-btn"
            onClick={() => entry.isDir && toggleDir(path)}
            style={{ ...styles.iconButton, visibility: entry.isDir ? "visible" : "hidden" }}
            title={entry.isDir ? (isExpanded ? "Collapse" : "Expand") : undefined}
          >
            {isExpanded ? "▾" : "▸"}
          </button>
          <span style={entry.isDir ? styles.dirIcon : styles.fileIcon}>{entry.isDir ? "DIR" : "FILE"}</span>
          <span style={styles.name} title={path}>{entry.name}</span>
          <span style={styles.meta}>{entry.isDir ? "" : formatSize(entry.size)}</span>
          <span style={styles.meta}>{formatMtime(entry.mtime)}</span>
          <a className="wmux-btn" href={buildDownloadUrl(path, token)} style={styles.download} title="Download">
            ↓
          </a>
        </div>
        {entry.isDir && isExpanded && (
          <div>
            {child?.loading && <div style={{ ...styles.status, paddingLeft: 38 + (depth + 1) * 18 }}>Loading</div>}
            {child?.error && <div style={{ ...styles.error, paddingLeft: 38 + (depth + 1) * 18 }}>{child.error}</div>}
            {child?.entries.map((childEntry) => renderEntry(path, childEntry, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const root = rootPath ? dirs.get(rootPath) : undefined;

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <div style={styles.titleGroup}>
          <span className="wmux-section-label">FILES</span>
          <span style={styles.path} title={rootPath ?? ""}>{rootPath ?? "..."}</span>
        </div>
        <button className="wmux-btn" onClick={refresh} style={styles.refresh} title="Refresh">
          ↻
        </button>
      </div>

      {!token ? (
        <div style={styles.errorBlock}>Missing token</div>
      ) : root?.error ? (
        <div style={styles.errorBlock}>{root.error}</div>
      ) : (
        <div style={styles.tree}>
          {root?.loading && <div style={styles.status}>Loading</div>}
          {root?.entries.map((entry) => renderEntry(rootPath ?? "", entry, 0))}
        </div>
      )}
    </section>
  );
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    height: "100%",
    background: "var(--wmux-bg-soft)",
    color: "var(--wmux-text)",
    fontFamily: "var(--wmux-font-display)",
  },
  header: {
    height: 45,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "0 12px",
    borderBottom: "1px solid var(--wmux-hairline)",
    background: "var(--wmux-bg)",
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
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  refresh: {
    width: 28,
    height: 28,
    flexShrink: 0,
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    fontSize: 14,
  },
  tree: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "6px 0",
  },
  row: {
    minHeight: 30,
    display: "grid",
    gridTemplateColumns: "18px 38px minmax(80px, 1fr) 76px 116px 30px",
    alignItems: "center",
    gap: 8,
    paddingRight: 10,
    borderBottom: "1px solid rgba(255,255,255,0.025)",
    color: "var(--wmux-text)",
    fontSize: 12,
  },
  iconButton: {
    width: 18,
    height: 22,
    border: "none",
    background: "transparent",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: 0,
    fontSize: 13,
  },
  dirIcon: {
    color: "var(--wmux-accent)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    fontWeight: 700,
  },
  fileIcon: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    fontWeight: 700,
  },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  download: {
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-subtext)",
    textDecoration: "none",
    fontSize: 13,
  },
  status: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    padding: "8px 14px",
  },
  error: {
    color: "#f38ba8",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    padding: "8px 14px",
  },
  errorBlock: {
    color: "#f38ba8",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    padding: 14,
  },
};
