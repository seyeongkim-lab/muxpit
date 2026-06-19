import { useEffect, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspace";
import { useSettingsStore } from "../stores/settings";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { terminalInstances } from "./terminalRegistry";

interface TerminalLeafProps {
  workspaceId: string;
  leafId: string;
}

export const TerminalLeaf = ({ workspaceId, leafId }: TerminalLeafProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const setFocusedLeaf = useWorkspaceStore((s) => s.setFocusedLeaf);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const focusedLeafId = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.focusedLeafId,
  );

  useTerminalSession({ workspaceId, leafId, containerRef, initializedRef });

  // Apply font settings changes to existing terminals.
  // The current terminal surface renders its own canvas, so Chromium's `zoom` on <html> (used by App.tsx to
  // scale the chrome) does not reach the WebGL canvas. The terminal font must be
  // resized through the surface options. fit() runs in the next frame because the
  // zoom useEffect in App.tsx also fires on fontSize changes and the relative order
  // isn't guaranteed — waiting a frame ensures zoom is already applied.
  useEffect(() => {
    const instance = terminalInstances.get(leafId);
    if (instance) {
      instance.surface.setFont(fontSize, fontFamily);
      requestAnimationFrame(() => instance.surface.fit());
    }
  }, [fontSize, fontFamily, leafId]);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver(() => {
      const instance = terminalInstances.get(leafId);
      if (instance) requestAnimationFrame(() => instance.surface.fit());
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [leafId]);

  // Focus management — only force-focus when the browser focus is NOT already
  // inside this terminal. A mousedown on an unfocused pane triggers
  // `setFocusedLeaf`, which re-runs this effect; calling focus() during
  // an active drag selection yanks focus to the helper textarea and clears the
  // selection before `mouseup`, so the user cannot copy by drag. Native click
  // already focuses the terminal, so skipping the explicit focus() in that path is safe.
  useEffect(() => {
    if (focusedLeafId !== leafId) return;
    const instance = terminalInstances.get(leafId);
    if (!instance) return;
    if (instance.surface.containsActiveElement(document.activeElement)) return;
    instance.surface.focus();
  }, [focusedLeafId, leafId]);

  const handleMouseDown = () => {
    if (focusedLeafId !== leafId) setFocusedLeaf(workspaceId, leafId);
  };
  const isFocused = focusedLeafId === leafId;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1e1e2e",
        opacity: isFocused ? 1 : 0.7,
        transition: "opacity 0.15s",
      }}
    />
  );
};
