import { type Workspace, collectLeafIds, useWorkspaceStore } from "../stores/workspace";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { SplitPane } from "./SplitPane";

interface GridOverviewProps {
  workspaces: Workspace[];
  activeId: string | null;
}

const getGridDimensions = (count: number): { cols: number; rows: number } => {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
};

export const GridOverview = ({ workspaces, activeId }: GridOverviewProps) => {
  const { cols, rows } = getGridDimensions(workspaces.length);
  const gap = 4;

  return (
    <div style={styles.container}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap,
          width: "100%",
          height: "100%",
        }}
      >
        {workspaces.map((ws) => (
          <GridCell
            key={ws.id}
            workspace={ws}
            isActive={ws.id === activeId}
          />
        ))}
      </div>
    </div>
  );
};

interface GridCellProps {
  workspace: Workspace;
  isActive: boolean;
}

const GridCell = ({ workspace, isActive }: GridCellProps) => {
  const infoMap = useWorkspaceInfoStore((s) => s.info);
  const info = infoMap[workspace.id];
  const paneCount = collectLeafIds(workspace.layout).length;
  const setActive = useWorkspaceStore((s) => s.setActive);

  const handleFocus = () => {
    setActive(workspace.id);
  };

  return (
    <div
      onMouseDown={handleFocus}
      style={{
        ...styles.cell,
        borderColor: isActive ? "#89b4fa" : "#313244",
      }}
    >
      {/* Header */}
      <div style={{
        ...styles.cellHeader,
        backgroundColor: isActive ? "#1e1e2e" : "#181825",
      }}>
        <span style={{ ...styles.cellName, color: isActive ? "#89b4fa" : "#cdd6f4" }}>
          {workspace.name}
        </span>
        <div style={styles.cellMeta}>
          {info?.gitBranch && (
            <span style={styles.cellBranch}>{info.gitBranch}</span>
          )}
          {paneCount > 1 && (
            <span style={styles.cellPanes}>{paneCount}p</span>
          )}
        </div>
      </div>

      {/* Live terminal — fully interactive */}
      <div style={styles.terminalArea}>
        <SplitPane node={workspace.layout} workspaceId={workspace.id} />
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
    height: "100%",
    backgroundColor: "#11111b",
    overflow: "hidden",
  },
  cell: {
    display: "flex",
    flexDirection: "column",
    borderRadius: 6,
    border: "2px solid #313244",
    overflow: "hidden",
    transition: "border-color 0.15s",
  },
  cellHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "2px 8px",
    borderBottom: "1px solid #313244",
    height: 24,
    flexShrink: 0,
  },
  cellName: {
    fontSize: 11,
    fontWeight: 600,
    fontFamily: "'JetBrains Mono', monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  cellMeta: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    flexShrink: 0,
  },
  cellBranch: {
    color: "#a6e3a1",
    fontSize: 10,
    fontFamily: "monospace",
  },
  cellPanes: {
    color: "#585b70",
    fontSize: 10,
  },
  terminalArea: {
    flex: 1,
    overflow: "hidden",
  },
};
