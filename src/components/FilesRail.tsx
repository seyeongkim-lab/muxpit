import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SshConnection } from "../utils/sshConnection";
import { clampFilesRailWidth, useSidebarLayoutStore } from "../stores/sidebarLayout";

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number | null;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
}

interface DirState {
  entries: DirEntry[];
  loading: boolean;
  error: string | null;
}

interface FilesRailProps {
  cwd?: string | null;
  sshConnection?: SshConnection | null;
  sshCommand?: string | null;
}

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

const joinPath = (parent: string, name: string): string => {
  if (!parent) return name;
  if (parent.endsWith("/") || parent.endsWith("\\")) return `${parent}${name}`;
  return parent.includes("\\") && !parent.includes("/") ? `${parent}\\${name}` : `${parent}/${name}`;
};

const normalizeRemoteCwd = (cwd: string): string => {
  if (!cwd.startsWith("\\\\")) return cwd;
  const withoutPrefix = cwd.replace(/^\\\\[^\\]+\\?/, "");
  return `/${withoutPrefix.replace(/\\/g, "/")}`.replace(/\/+/g, "/");
};

const FilesRailImpl = ({ cwd, sshConnection, sshCommand }: FilesRailProps) => {
  const isRemote = !!(sshConnection?.program || (sshCommand && sshCommand.trim()));
  const requestedRoot = useMemo(() => {
    const trimmed = cwd?.trim() ?? "";
    if (!trimmed) return "";
    return isRemote ? normalizeRemoteCwd(trimmed) : trimmed;
  }, [cwd, isRemote]);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const asideRef = useRef<HTMLElement>(null);
  const railWidth = useSidebarLayoutStore((s) => s.filesRailWidth);
  const setRailWidth = useSidebarLayoutStore((s) => s.setFilesRailWidth);

  // Drag the right edge to resize. During the drag the width is written straight
  // to the DOM node so the (potentially large) file tree doesn't reconcile every
  // frame; the store — and localStorage — is committed once on mouse up.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = asideRef.current?.getBoundingClientRect().width ?? railWidth;
      let pending = startWidth;
      let frameId: number | null = null;

      const apply = () => {
        frameId = null;
        if (asideRef.current) {
          asideRef.current.style.width = `${pending}px`;
          asideRef.current.style.minWidth = `${pending}px`;
        }
      };

      const onMouseMove = (ev: MouseEvent) => {
        pending = clampFilesRailWidth(startWidth + (ev.clientX - startX));
        if (frameId === null) frameId = requestAnimationFrame(apply);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (frameId !== null) cancelAnimationFrame(frameId);
        setRailWidth(pending);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [railWidth, setRailWidth],
  );

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
        const result = isRemote
          ? await invoke<DirListing>("remote_read_dir", {
              path: requestPath,
              sshCommand: sshCommand ?? null,
              sshConnection: sshConnection ?? null,
            })
          : await invoke<DirListing>("read_dir", { path: requestPath || null });

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
    [isRemote, sshCommand, sshConnection],
  );

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
    void loadPath(rootPath ?? requestedRoot);
  }, [loadPath, requestedRoot, rootPath]);

  const renderEntry = (parentPath: string, entry: DirEntry, depth: number) => {
    const path = joinPath(parentPath, entry.name);
    const isExpanded = expanded.has(path);
    const child = dirs.get(path);

    return (
      <div key={path}>
        <div className="wmux-file-row" style={{ ...styles.row, paddingLeft: 10 + depth * 12 }}>
          <button
            className="wmux-btn"
            onClick={() => entry.isDir && toggleDir(path)}
            style={{ ...styles.expandButton, visibility: entry.isDir ? "visible" : "hidden" }}
            title={entry.isDir ? (isExpanded ? "Collapse folder" : "Expand folder") : undefined}
          >
            {isExpanded ? "v" : ">"}
          </button>
          <span style={entry.isDir ? styles.dirMark : styles.fileMark}>{entry.isDir ? "D" : "F"}</span>
          <span style={styles.fileName} title={path}>{entry.name}</span>
          <span style={styles.fileSize}>{entry.isDir ? "" : formatSize(entry.size)}</span>
        </div>
        {entry.isDir && isExpanded && (
          <div>
            {child?.loading && <div style={{ ...styles.status, paddingLeft: 30 + (depth + 1) * 12 }}>loading</div>}
            {child?.error && <div style={{ ...styles.error, paddingLeft: 30 + (depth + 1) * 12 }}>{child.error}</div>}
            {child?.entries.map((childEntry) => renderEntry(path, childEntry, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const activeRootKey = rootPath ?? requestedRoot;
  const root = dirs.get(activeRootKey);

  return (
    <aside ref={asideRef} style={{ ...styles.rail, width: railWidth, minWidth: railWidth }}>
      <div style={styles.header}>
        <div style={styles.titleGroup}>
          <span className="wmux-section-label">FILES</span>
          <span style={styles.path} title={rootPath ?? requestedRoot}>
            {rootPath ? compactPath(rootPath) : requestedRoot ? compactPath(requestedRoot) : "current directory"}
          </span>
        </div>
        <button className="wmux-btn" onClick={refresh} style={styles.refresh} title="Refresh files">
          r
        </button>
      </div>
      <div style={styles.tree}>
        {root?.loading && <div style={styles.status}>loading</div>}
        {root?.error && <div style={styles.errorBlock}>{root.error}</div>}
        {root && !root.loading && !root.error && root.entries.length === 0 && (
          <div style={styles.status}>empty</div>
        )}
        {root?.entries.map((entry) => renderEntry(activeRootKey, entry, 0))}
      </div>
      <div
        className="wmux-rail-resize"
        style={styles.resizeHandle}
        onMouseDown={startResize}
        title="Drag to resize"
      />
    </aside>
  );
};

export const FilesRail = memo(FilesRailImpl);

const styles: Record<string, React.CSSProperties> = {
  rail: {
    position: "relative",
    height: "100%",
    flexShrink: 0,
    backgroundColor: "var(--wmux-bg)",
    borderRight: "1px solid var(--wmux-hairline)",
    display: "flex",
    flexDirection: "column",
    userSelect: "none",
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    right: -3,
    width: 6,
    height: "100%",
    cursor: "col-resize",
    zIndex: 5,
  },
  header: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 24px",
    alignItems: "center",
    gap: 8,
    padding: "10px 10px 7px 12px",
    borderBottom: "1px solid var(--wmux-hairline)",
  },
  titleGroup: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  path: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  refresh: {
    width: 24,
    height: 24,
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: 0,
    fontSize: 12,
  },
  tree: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "4px 0 8px",
  },
  row: {
    minHeight: 25,
    display: "grid",
    gridTemplateColumns: "16px 14px minmax(0, 1fr) 44px",
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
  status: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    padding: "7px 12px",
  },
  error: {
    color: "#f38ba8",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    padding: "7px 12px",
  },
  errorBlock: {
    color: "#f38ba8",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    padding: "7px 12px",
    whiteSpace: "pre-wrap",
  },
};
