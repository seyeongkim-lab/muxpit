import { useRef, useCallback } from "react";
import { LayoutNode, useWorkspaceStore } from "../stores/workspace";
import { TerminalLeaf } from "./Terminal";
import { BrowserPane } from "./BrowserPane";
import { MonitorPane } from "./MonitorPane";

interface SplitPaneProps {
  node: LayoutNode;
  workspaceId: string;
}

export const SplitPane = ({ node, workspaceId }: SplitPaneProps) => {
  if (node.type === "leaf") {
    return <TerminalLeaf key={node.id} workspaceId={workspaceId} leafId={node.id} />;
  }

  if (node.type === "browser") {
    return <BrowserPane key={node.id} id={node.id} url={node.url} />;
  }

  if (node.type === "monitor") {
    return <MonitorPane key={node.id} id={node.id} sshTarget={node.sshTarget} monitorId={node.monitorId} />;
  }

  return (
    <SplitContainer
      node={node}
      workspaceId={workspaceId}
    />
  );
};

interface SplitContainerProps {
  node: LayoutNode & { type: "split" };
  workspaceId: string;
}

const SplitContainer = ({ node, workspaceId }: SplitContainerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const setSplitRatio = useWorkspaceStore((s) => s.setSplitRatio);
  const isHorizontal = node.direction === "horizontal";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();

      const onMouseMove = (ev: MouseEvent) => {
        const ratio = isHorizontal
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
        setSplitRatio(workspaceId, node.id, ratio);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [isHorizontal, node.id, workspaceId, setSplitRatio],
  );

  const firstSize = `${node.ratio * 100}%`;
  const secondSize = `${(1 - node.ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: isHorizontal ? "row" : "column",
        width: "100%",
        height: "100%",
      }}
    >
      <div style={{ width: isHorizontal ? firstSize : "100%", height: isHorizontal ? "100%" : firstSize, overflow: "hidden" }}>
        <SplitPane node={node.children[0]} workspaceId={workspaceId} />
      </div>

      {/* Divider */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          width: isHorizontal ? 4 : "100%",
          height: isHorizontal ? "100%" : 4,
          backgroundColor: "#313244",
          cursor: isHorizontal ? "col-resize" : "row-resize",
          flexShrink: 0,
          transition: "background-color 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.target as HTMLElement).style.backgroundColor = "#89b4fa";
        }}
        onMouseLeave={(e) => {
          (e.target as HTMLElement).style.backgroundColor = "#313244";
        }}
      />

      <div style={{ width: isHorizontal ? secondSize : "100%", height: isHorizontal ? "100%" : secondSize, overflow: "hidden" }}>
        <SplitPane node={node.children[1]} workspaceId={workspaceId} />
      </div>
    </div>
  );
};
