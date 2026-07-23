// Right-side overlay for reading a file without disturbing the pane layout.
// Markdown renders as a document, code renders highlighted, and the terminal
// underneath stays interactive — Escape only closes while the drawer itself
// has focus, so a vim session in the terminal never loses its Escape.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFileViewerStore } from "../stores/fileViewer";
import { clampFileViewerWidth, useSidebarLayoutStore } from "../stores/sidebarLayout";
import { MarkdownContent } from "./AgentMessageContent";
import { CodeHighlight } from "./CodeHighlight";
import { isMarkdownFile, languageForFile } from "../utils/fileLink";
import { compactPath, formatSize } from "../utils/pathDisplay";
import { beginEdgeDrag } from "../utils/edgeResize";
import "./FileViewerDrawer.css";

interface FileContentPayload {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

export const FileViewerDrawer = () => {
  const open = useFileViewerStore((s) => s.open);
  const path = useFileViewerStore((s) => s.path);
  const target = useFileViewerStore((s) => s.target);
  const requestNonce = useFileViewerStore((s) => s.requestNonce);
  const close = useFileViewerStore((s) => s.close);
  const width = useSidebarLayoutStore((s) => s.fileViewerWidth);
  const setWidth = useSidebarLayoutStore((s) => s.setFileViewerWidth);

  const [payload, setPayload] = useState<FileContentPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawView, setRawView] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setRawView(false);
  }, [requestNonce]);

  useEffect(() => {
    if (!open || !path) return;
    let active = true;
    setPayload(null);
    setLoading(true);
    setError(null);
    const remote = !!(target.sshCommand || target.sshConnection);
    invoke<FileContentPayload>(remote ? "remote_read_file" : "read_file", {
      path,
      cwd: target.cwd ?? null,
      ...(remote
        ? { sshCommand: target.sshCommand ?? null, sshConnection: target.sshConnection ?? null }
        : {}),
    }).then(
      (result) => {
        if (!active) return;
        setPayload(result);
        setLoading(false);
      },
      (reason) => {
        if (!active) return;
        setError(String(reason));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [open, path, target, requestNonce, refreshNonce]);

  useEffect(() => {
    if (open) asideRef.current?.focus();
  }, [open, requestNonce]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      beginEdgeDrag({
        startX: e.clientX,
        startWidth: asideRef.current?.getBoundingClientRect().width ?? width,
        direction: -1,
        clamp: clampFileViewerWidth,
        apply: (w) => {
          if (asideRef.current) asideRef.current.style.width = `${w}px`;
        },
        commit: setWidth,
      });
    },
    [setWidth, width],
  );

  if (!open || !path) return null;

  const markdown = isMarkdownFile(path);
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const shownPath = payload?.path ?? path;
  const loaded = !loading && !error && payload;

  return (
    <aside
      ref={asideRef}
      className="file-viewer"
      style={{ width }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="file-viewer-resize" onMouseDown={startResize} title="Drag to resize" />
      <header className="file-viewer-header">
        <strong title={shownPath}>{fileName}</strong>
        <span title={shownPath}>{compactPath(shownPath)}</span>
        <div className="file-viewer-actions">
          {markdown && loaded && !payload.binary ? (
            <button
              type="button"
              className="muxpit-btn"
              onClick={() => setRawView((v) => !v)}
              title={rawView ? "Render markdown" : "Show raw text"}
            >
              {rawView ? "Rendered" : "Raw"}
            </button>
          ) : null}
          <button
            type="button"
            className="muxpit-btn"
            onClick={() => setRefreshNonce((n) => n + 1)}
            title="Reload file"
          >
            Reload
          </button>
          <button type="button" className="muxpit-btn" onClick={close} title="Close viewer (Esc)">
            x
          </button>
        </div>
      </header>
      <div className="file-viewer-body">
        {loading ? <div className="file-viewer-status">Loading…</div> : null}
        {!loading && error ? <div className="file-viewer-error">{error}</div> : null}
        {loaded && payload.binary ? (
          <div className="file-viewer-status">Binary file · {formatSize(payload.size)}</div>
        ) : null}
        {loaded && !payload.binary ? (
          markdown && !rawView ? (
            <div className="file-viewer-doc">
              <MarkdownContent text={payload.content} highlightCode />
            </div>
          ) : (
            <pre className="file-viewer-code">
              <CodeHighlight code={payload.content} language={languageForFile(path)} />
            </pre>
          )
        ) : null}
      </div>
      {loaded && payload.truncated ? (
        <footer className="file-viewer-footer">
          Showing the first {formatSize(1024 * 1024)} of {formatSize(payload.size)}.
        </footer>
      ) : null}
    </aside>
  );
};
