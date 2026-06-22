import { useState, useEffect, useRef, useMemo } from "react";
import { useHistoryStore } from "../stores/history";
import { usePrefixStore } from "../stores/prefix";
import { useWorkspaceStore } from "../stores/workspace";
import type { LayoutNode } from "../stores/workspace";
import { getPtyBackend } from "../utils/runtimePtyBackend";

const findFocusedPtyId = (node: LayoutNode, focusedLeafId: string): number | null => {
  if (node.type === "leaf" && node.id === focusedLeafId) return node.ptyId;
  if (node.type === "split") {
    return (
      findFocusedPtyId(node.children[0], focusedLeafId) ??
      findFocusedPtyId(node.children[1], focusedLeafId)
    );
  }
  return null;
};

export const HistoryPanel = () => {
  const open = usePrefixStore((s) => s.historyOpen);
  const setOpen = usePrefixStore((s) => s.setHistoryOpen);
  const entries = useHistoryStore((s) => s.entries);
  const clearHistory = useHistoryStore((s) => s.clear);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reverse + dedup (keep latest occurrence) so most recent unique commands come first
  const filtered = useMemo(() => {
    const seen = new Set<string>();
    const result: { command: string; workspaceId: string; leafId: string; timestamp: number }[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (seen.has(e.command)) continue;
      seen.add(e.command);
      if (query && !e.command.toLowerCase().includes(query.toLowerCase())) continue;
      result.push(e);
    }
    return result;
  }, [entries, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (selectedIdx >= filtered.length) setSelectedIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIdx]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const node = listRef.current.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (!open) return null;

  const pasteToFocusedPane = async (command: string) => {
    const st = useWorkspaceStore.getState();
    const ws = st.workspaces.find((w) => w.id === st.activeId);
    if (!ws) return;
    const ptyId = findFocusedPtyId(ws.layout, ws.focusedLeafId);
    if (ptyId == null) return;
    await getPtyBackend().write(ptyId, command).catch(() => {});
  };

  const onSelect = async (command: string) => {
    await pasteToFocusedPane(command);
    setOpen(false);
  };

  const onKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const picked = filtered[selectedIdx];
      if (picked) await onSelect(picked.command);
      return;
    }
  };

  return (
    <div style={styles.overlay} onClick={() => setOpen(false)}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div style={styles.header}>
          <span style={styles.title}>Command History</span>
          <button onClick={() => clearHistory()} style={styles.clearBtn} title="Clear all">
            Clear
          </button>
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIdx(0);
          }}
          placeholder="Search commands..."
          style={styles.input}
        />
        <div style={styles.list} ref={listRef}>
          {filtered.length === 0 && (
            <div style={styles.empty}>
              {entries.length === 0
                ? "No history yet — run some commands in a bash/zsh pane."
                : "No matches."}
            </div>
          )}
          {filtered.map((e, i) => {
            const isSelected = i === selectedIdx;
            return (
              <div
                key={`${e.command}-${i}`}
                data-idx={i}
                onClick={() => onSelect(e.command)}
                onMouseEnter={() => setSelectedIdx(i)}
                style={{
                  ...styles.item,
                  ...(isSelected ? styles.itemSelected : {}),
                }}
              >
                <span style={styles.command}>{e.command}</span>
              </div>
            );
          })}
        </div>
        <div style={styles.footer}>
          ↑/↓ navigate · Enter paste · Esc cancel
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    zIndex: 200,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    paddingTop: "15vh",
  },
  panel: {
    width: 560,
    maxHeight: "70vh",
    backgroundColor: "#181825",
    border: "1px solid #313244",
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    borderBottom: "1px solid #313244",
  },
  title: { color: "#cdd6f4", fontSize: 13, fontWeight: 600 },
  clearBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#f38ba8",
    fontSize: 11,
    padding: "3px 10px",
    cursor: "pointer",
  },
  input: {
    margin: "10px 14px",
    padding: "8px 10px",
    background: "#1e1e2e",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#cdd6f4",
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    outline: "none",
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "4px 8px",
  },
  item: {
    padding: "6px 10px",
    borderRadius: 4,
    cursor: "pointer",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: "#a6adc8",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  itemSelected: {
    background: "#313244",
    color: "#cdd6f4",
  },
  command: {},
  empty: {
    padding: 24,
    textAlign: "center",
    color: "#585b70",
    fontSize: 12,
  },
  footer: {
    padding: "8px 14px",
    borderTop: "1px solid #313244",
    color: "#585b70",
    fontSize: 10,
    fontFamily: "monospace",
  },
};
