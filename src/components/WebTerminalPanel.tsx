import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createTerminalSurface, type TerminalSurface } from "./terminalSurface";
import { getResolvedTheme } from "../themes";
import { getServerToken, WmuxServerClient } from "../utils/wmuxServerClient";

const theme = getResolvedTheme("Catppuccin Mocha", {});

export const WebTerminalPanel = () => {
  const token = getServerToken();
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !token) {
      setStatus(token ? "missing container" : "missing token");
      return;
    }

    let disposed = false;
    let ptyId = 0;
    let surface: TerminalSurface | null = null;
    const client = new WmuxServerClient(token);

    const cleanupOutput = client.onOutput((payload) => {
      if (payload.ptyId === ptyId) surface?.write(payload.data);
    });
    const cleanupExit = client.onExit((payload) => {
      if (payload.ptyId !== ptyId) return;
      surface?.write(`\r\n\x1b[31m[Process exited${payload.code === null ? "" : `: ${payload.code}`}]\x1b[0m\r\n`);
      setStatus("exited");
    });

    surface = createTerminalSurface({
      fontSize: 14,
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      theme,
      enableWebglRenderer: false,
      clearStaleInputBufferAfterTextInput: false,
      openLink: (uri) => window.open(uri, "_blank", "noopener,noreferrer"),
    });
    surface.open(container);

    const onData = surface.onData((data) => {
      if (ptyId === 0) return;
      client.writePty(ptyId, data).catch((err) => {
        surface?.write(`\r\n\x1b[31m[write failed: ${err instanceof Error ? err.message : String(err)}]\x1b[0m\r\n`);
      });
    });
    const onResize = surface.onResize(({ rows, cols }) => {
      if (ptyId === 0) return;
      client.resizePty(ptyId, rows, cols).catch(() => {});
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!surface) return;
      requestAnimationFrame(() => {
        if (!surface) return;
        surface.fit();
        if (ptyId !== 0) {
          client.resizePty(ptyId, Math.max(surface.rows, 1), Math.max(surface.cols, 1)).catch(() => {});
        }
      });
    });
    resizeObserver.observe(container);

    requestAnimationFrame(() => {
      if (disposed || !surface) return;
      surface.fit();
      client
        .spawnTerminal({
          rows: Math.max(surface.rows, 1),
          cols: Math.max(surface.cols, 1),
        })
        .then((id) => {
          if (disposed) {
            client.killPty(id).catch(() => {});
            return;
          }
          ptyId = id;
          setStatus("connected");
          surface?.focus();
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          setStatus("failed");
          surface?.write(`\r\n\x1b[31m[spawn failed: ${message}]\x1b[0m\r\n`);
        });
    });

    return () => {
      disposed = true;
      if (ptyId !== 0) client.killPty(ptyId).catch(() => {});
      cleanupOutput();
      cleanupExit();
      resizeObserver.disconnect();
      onData.dispose();
      onResize.dispose();
      surface?.dispose();
      client.close();
    };
  }, [token]);

  return (
    <section style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>terminal</span>
        <span style={styles.status}>{status}</span>
      </div>
      <div ref={containerRef} style={styles.terminal} />
    </section>
  );
};

const styles: Record<string, CSSProperties> = {
  panel: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "#1e1e2e",
  },
  header: {
    height: 30,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "0 10px",
    borderBottom: "1px solid var(--wmux-hairline)",
    background: "var(--wmux-bg-soft)",
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
  },
  title: {
    color: "var(--wmux-accent)",
    fontWeight: 700,
  },
  status: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  terminal: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    overflow: "hidden",
  },
};
