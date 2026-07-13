import { memo, useRef, useCallback } from "react";
import { LayoutNode, useWorkspaceStore } from "../stores/workspace";
import { TerminalLeaf } from "./Terminal";
import { BrowserPane } from "./BrowserPane";
import { MonitorPane } from "./MonitorPane";
import { ClaudeSessionPane } from "./ClaudeSessionPane";
import { AiPaneToolbar } from "./AiPaneToolbar";

interface SplitPaneProps {
  node: LayoutNode;
  workspaceId: string;
  browserVisible?: boolean;
  createBrowserWebview?: boolean;
}

const SplitPaneImpl = ({
  node,
  workspaceId,
  browserVisible = true,
  createBrowserWebview = true,
}: SplitPaneProps) => {
  if (node.type === "leaf") {
    if (node.aiKind && node.aiSshTarget) {
      // Wrap the terminal so the toolbar sits above it without breaking xterm's
      // ResizeObserver — the wrapper is a column flex and the terminal slot
      // claims the remaining space (`flex: 1, minHeight: 0`).
      return (
        <div key={node.id} style={leafWrapperStyle}>
          <AiPaneToolbar
            workspaceId={workspaceId}
            leafId={node.id}
            currentKind={node.aiKind}
            sshTarget={node.aiSshTarget}
            sshConnection={node.sshConnection}
          />
          <div style={leafTerminalSlotStyle}>
            <TerminalLeaf workspaceId={workspaceId} leafId={node.id} />
          </div>
        </div>
      );
    }
    return <TerminalLeaf key={node.id} workspaceId={workspaceId} leafId={node.id} />;
  }

  if (node.type === "browser") {
    return (
      <BrowserPane
        key={node.id}
        workspaceId={workspaceId}
        id={node.id}
        url={node.url}
        visible={browserVisible}
        createWebview={createBrowserWebview}
      />
    );
  }

  if (node.type === "monitor") {
    return <MonitorPane key={node.id} id={node.id} sshTarget={node.sshTarget} sshCommand={node.sshCommand} sshConnection={node.sshConnection} monitorId={node.monitorId} />;
  }

  if (node.type === "claudeSession") {
    return <ClaudeSessionPane key={node.id} id={node.id} sshTarget={node.sshTarget} sshConnection={node.sshConnection} project={node.project} projectPath={node.projectPath} sessionId={node.sessionId} monitorId={node.monitorId} />;
  }

  return (
    <SplitContainer
      node={node}
      workspaceId={workspaceId}
      browserVisible={browserVisible}
      createBrowserWebview={createBrowserWebview}
    />
  );
};

export const SplitPane = memo(SplitPaneImpl);

interface SplitContainerProps {
  node: LayoutNode & { type: "split" };
  workspaceId: string;
  browserVisible: boolean;
  createBrowserWebview: boolean;
}

const SplitContainer = ({
  node,
  workspaceId,
  browserVisible,
  createBrowserWebview,
}: SplitContainerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const setSplitRatio = useWorkspaceStore((s) => s.setSplitRatio);
  const isHorizontal = node.direction === "horizontal";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      let pendingRatio = node.ratio;
      let frameId: number | null = null;

      const commitRatio = () => {
        frameId = null;
        setSplitRatio(workspaceId, node.id, pendingRatio);
      };

      const queueRatio = (ratio: number) => {
        if (!Number.isFinite(ratio)) return;
        pendingRatio = ratio;
        if (frameId === null) {
          frameId = requestAnimationFrame(commitRatio);
        }
      };

      const onMouseMove = (ev: MouseEvent) => {
        const ratio = isHorizontal
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
        queueRatio(ratio);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (frameId !== null) {
          cancelAnimationFrame(frameId);
          frameId = null;
        }
        setSplitRatio(workspaceId, node.id, pendingRatio);
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
        <SplitPane
          node={node.children[0]}
          workspaceId={workspaceId}
          browserVisible={browserVisible}
          createBrowserWebview={createBrowserWebview}
        />
      </div>

      {/* Divider */}
      <div
        onMouseDown={handleMouseDown}
        className="wmux-split-divider"
        style={{
          width: isHorizontal ? 4 : "100%",
          height: isHorizontal ? "100%" : 4,
          cursor: isHorizontal ? "col-resize" : "row-resize",
          flexShrink: 0,
        }}
      />

      <div style={{ width: isHorizontal ? secondSize : "100%", height: isHorizontal ? "100%" : secondSize, overflow: "hidden" }}>
        <SplitPane
          node={node.children[1]}
          workspaceId={workspaceId}
          browserVisible={browserVisible}
          createBrowserWebview={createBrowserWebview}
        />
      </div>
    </div>
  );
};

const leafWrapperStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  minHeight: 0,
};

const leafTerminalSlotStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: "100%",
};
