import { usePrefixStore } from "../stores/prefix";
import { useWorkspaceStore } from "../stores/workspace";
import { collectRects } from "../utils/layoutGeometry";

interface Props {
  workspaceId: string;
}

export const PaneNumberOverlay = ({ workspaceId }: Props) => {
  const show = usePrefixStore((s) => s.showPaneNumbers);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));

  if (!show || !workspace) return null;
  if (workspace.zoomedLeafId) return null;

  const rects = collectRects(workspace.layout);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 999,
      }}
    >
      {rects.map((r, i) => (
        <div
          key={r.id}
          style={{
            position: "absolute",
            left: `${r.x * 100}%`,
            top: `${r.y * 100}%`,
            width: `${r.w * 100}%`,
            height: `${r.h * 100}%`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 96,
            fontWeight: 900,
            color: r.id === workspace.focusedLeafId ? "#f9e2af" : "#89b4fa",
            textShadow: "0 4px 16px rgba(0,0,0,0.9)",
            userSelect: "none",
          }}
        >
          {i}
        </div>
      ))}
    </div>
  );
};
