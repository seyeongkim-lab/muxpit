import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace";
import { browserWebviewLabel, normalizeBrowserUrl } from "../utils/browserWebview";

interface BrowserPaneProps {
  workspaceId: string;
  url: string;
  id: string;
  visible: boolean;
  createWebview: boolean;
}

interface BrowserNavigatedEvent {
  label: string;
  url: string;
}

interface BrowserUrlResult {
  url: string;
}

export const BrowserPane = ({
  workspaceId,
  url,
  id,
  visible,
  createWebview,
}: BrowserPaneProps) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  const [inputUrl, setInputUrl] = useState(url);
  const [error, setError] = useState<string | null>(null);
  const setBrowserUrl = useWorkspaceStore((state) => state.setBrowserUrl);
  const setFocusedLeaf = useWorkspaceStore((state) => state.setFocusedLeaf);
  const label = browserWebviewLabel(id);
  visibleRef.current = visible;

  useEffect(() => setInputUrl(url), [url]);

  useEffect(() => {
    if (!createWebview) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    let frameId: number | undefined;

    const updateBounds = async () => {
      const viewport = viewportRef.current;
      if (!viewport || disposed) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      await invoke("browser_update_bounds", {
        label,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };

    const queueBoundsUpdate = () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        frameId = undefined;
        updateBounds().catch((value) => {
          if (!disposed) setError(String(value));
        });
      });
    };

    const create = async () => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        frameId = requestAnimationFrame(create);
        return;
      }
      await invoke<BrowserUrlResult>("browser_create", {
        label,
        url,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      if (disposed) return;
      await invoke("browser_set_visible", { label, visible: visibleRef.current });
      setError(null);
      resizeObserver = new ResizeObserver(queueBoundsUpdate);
      resizeObserver.observe(viewport);
      window.addEventListener("resize", queueBoundsUpdate);
      window.addEventListener("scroll", queueBoundsUpdate, true);
    };

    create().catch((value) => {
      if (!disposed) setError(String(value));
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", queueBoundsUpdate);
      window.removeEventListener("scroll", queueBoundsUpdate, true);
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      invoke("browser_close", { label }).catch(() => {});
    };
  }, [createWebview, id, label]);

  useEffect(() => {
    if (!createWebview) return;
    invoke("browser_set_visible", { label, visible }).catch(() => {});
  }, [createWebview, label, visible]);

  useEffect(() => {
    const unlisten = listen<BrowserNavigatedEvent>("muxpit-browser-navigated", ({ payload }) => {
      if (payload.label !== label) return;
      setInputUrl(payload.url);
      setBrowserUrl(workspaceId, id, payload.url);
    });
    return () => {
      unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, [id, label, setBrowserUrl, workspaceId]);

  const navigate = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const target = normalizeBrowserUrl(inputUrl);
      const result = await invoke<BrowserUrlResult>("browser_navigate", { label, url: target });
      setInputUrl(result.url);
      setBrowserUrl(workspaceId, id, result.url);
      setError(null);
    } catch (value) {
      setError(String(value));
    }
  };

  const reload = async () => {
    try {
      await invoke("browser_reload", { label });
      setError(null);
    } catch (value) {
      setError(String(value));
    }
  };

  return (
    <div
      style={styles.container}
      onMouseDown={() => setFocusedLeaf(workspaceId, id)}
    >
      <form onSubmit={navigate} style={styles.urlBar}>
        <button type="button" onClick={reload} style={styles.navButton} title="Reload">
          R
        </button>
        <input
          value={inputUrl}
          onChange={(event) => setInputUrl(event.target.value)}
          style={styles.urlInput}
          placeholder="Enter URL"
          aria-label="Browser URL"
        />
        <button type="submit" style={styles.navButton} title="Go">
          Go
        </button>
      </form>
      <div ref={viewportRef} style={styles.viewport}>
        {!createWebview && <div style={styles.preview}>Browser · {url}</div>}
        {error && <div style={styles.error}>{error}</div>}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    backgroundColor: "var(--muxpit-bg)",
  },
  urlBar: {
    display: "flex",
    gap: 6,
    padding: "5px 7px",
    backgroundColor: "var(--muxpit-bg-soft)",
    borderBottom: "1px solid var(--muxpit-hairline)",
    alignItems: "center",
    flexShrink: 0,
  },
  navButton: {
    background: "var(--muxpit-bg-elev)",
    border: "1px solid var(--muxpit-hairline-strong)",
    borderRadius: 4,
    color: "var(--muxpit-subtext)",
    fontSize: 11,
    padding: "3px 8px",
    cursor: "pointer",
    flexShrink: 0,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    background: "var(--muxpit-bg)",
    border: "1px solid var(--muxpit-hairline-strong)",
    borderRadius: 4,
    color: "var(--muxpit-text)",
    fontSize: 12,
    padding: "4px 8px",
    outline: "none",
    fontFamily: "monospace",
  },
  viewport: {
    position: "relative",
    flex: 1,
    minHeight: 0,
    backgroundColor: "#fff",
  },
  preview: {
    padding: 10,
    color: "var(--muxpit-subtext)",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  error: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    padding: 20,
    color: "var(--muxpit-danger)",
    backgroundColor: "var(--muxpit-bg)",
    fontSize: 12,
    textAlign: "center",
  },
};
