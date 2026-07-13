import type { LayoutNode, LeafLaunchMetadata, SplitDirection, Workspace } from "../stores/workspace.ts";

export interface ControlRequestEvent {
  requestId: string;
  action: string;
  params: Record<string, unknown>;
}

interface WorkspaceSnapshot {
  workspaces: Workspace[];
  activeId: string | null;
}

export interface ControlRuntime {
  getWorkspaces: () => WorkspaceSnapshot;
  getLeafCwd: (workspaceId: string, surfaceId: string) => string | undefined;
  split: (
    workspaceId: string,
    surfaceId: string,
    direction: SplitDirection,
    command?: string,
    metadata?: LeafLaunchMetadata,
  ) => string;
  focus: (workspaceId: string, surfaceId: string) => void;
  write: (surfaceId: string, text: string) => Promise<void>;
  readVisibleText: (surfaceId: string, rows: number) => string[];
  openBrowser: (workspaceId: string, surfaceId: string, url: string) => string;
  browser: (
    surfaceId: string,
    action: "navigate" | "reload" | "url" | "snapshot" | "console" | "screenshot",
    value?: string,
  ) => Promise<unknown>;
  setBrowserUrl: (workspaceId: string, surfaceId: string, url: string) => void;
}

interface ControlTarget {
  workspace: Workspace;
  surface: Exclude<LayoutNode, { type: "split" }>;
  active: boolean;
}

const findSurface = (
  node: LayoutNode,
  surfaceId: string,
): Exclude<LayoutNode, { type: "split" }> | null => {
  if (node.type !== "split") return node.id === surfaceId ? node : null;
  return findSurface(node.children[0], surfaceId) ?? findSurface(node.children[1], surfaceId);
};

const collectSurfaces = (node: LayoutNode): Exclude<LayoutNode, { type: "split" }>[] => {
  if (node.type !== "split") return [node];
  return [...collectSurfaces(node.children[0]), ...collectSurfaces(node.children[1])];
};

const stringParam = (params: Record<string, unknown>, key: string): string | undefined => {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const resolveTarget = (
  snapshot: WorkspaceSnapshot,
  params: Record<string, unknown>,
): ControlTarget => {
  const workspaceId = stringParam(params, "workspace_id") ?? snapshot.activeId;
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  const surfaceId = stringParam(params, "surface_id") ?? workspace.focusedLeafId;
  const surface = findSurface(workspace.layout, surfaceId);
  if (!surface) throw new Error("Surface not found");
  return { workspace, surface, active: snapshot.activeId === workspace.id };
};

const resolveBrowserTarget = (
  snapshot: WorkspaceSnapshot,
  params: Record<string, unknown>,
): ControlTarget => {
  const target = resolveTarget(snapshot, params);
  if (target.surface.type === "browser") return target;
  const browsers = collectSurfaces(target.workspace.layout).filter(
    (surface) => surface.type === "browser",
  );
  if (browsers.length === 0) throw new Error("Browser surface not found");
  if (browsers.length > 1) throw new Error("Multiple browser surfaces found; specify --surface");
  return { ...target, surface: browsers[0] };
};

const resultUrl = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;
  const url = (result as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
};

const surfaceType = (surface: ControlTarget["surface"]): string =>
  surface.type === "leaf" ? "terminal" : surface.type;

const describeSurface = (
  target: ControlTarget,
  runtime: ControlRuntime,
): Record<string, unknown> => {
  const cwd = runtime.getLeafCwd(target.workspace.id, target.surface.id);
  const aiKind = target.surface.type === "leaf" ? target.surface.aiKind : undefined;
  return {
    workspaceId: target.workspace.id,
    workspaceName: target.workspace.name,
    surfaceId: target.surface.id,
    surfaceType: surfaceType(target.surface),
    focused: target.workspace.focusedLeafId === target.surface.id,
    active: target.active,
    ...(cwd ? { cwd } : {}),
    ...(aiKind ? { aiKind } : {}),
    ...(target.surface.type === "leaf" && target.surface.agentRole
      ? {
          agentRole: target.surface.agentRole,
          parentSurfaceId: target.surface.parentSurfaceId,
          agentLabel: target.surface.agentLabel,
        }
      : {}),
  };
};

export const executeControlRequest = async (
  request: ControlRequestEvent,
  runtime: ControlRuntime,
): Promise<unknown> => {
  const snapshot = runtime.getWorkspaces();
  if (request.action === "list-surfaces") {
    const workspaceId = stringParam(request.params, "workspace_id");
    const workspaces = workspaceId
      ? snapshot.workspaces.filter((workspace) => workspace.id === workspaceId)
      : snapshot.workspaces;
    if (workspaceId && workspaces.length === 0) throw new Error("Workspace not found");
    return workspaces.flatMap((workspace) =>
      collectSurfaces(workspace.layout).map((surface) =>
        describeSurface({ workspace, surface, active: snapshot.activeId === workspace.id }, runtime),
      ),
    );
  }

  if (request.action === "browser-open") {
    const target = resolveTarget(snapshot, request.params);
    if (target.surface.type !== "leaf") throw new Error("Only terminal surfaces can open a browser");
    const url = stringParam(request.params, "url");
    if (!url) throw new Error("Browser URL is required");
    const surfaceId = runtime.openBrowser(target.workspace.id, target.surface.id, url);
    runtime.focus(target.workspace.id, surfaceId);
    return { workspaceId: target.workspace.id, surfaceId };
  }

  if (request.action.startsWith("browser-")) {
    const target = resolveBrowserTarget(snapshot, request.params);
    const action = request.action.slice("browser-".length);
    if (![
      "navigate",
      "reload",
      "url",
      "snapshot",
      "console",
      "screenshot",
    ].includes(action)) {
      throw new Error(`Unknown control action: ${request.action}`);
    }
    const value = action === "navigate" ? stringParam(request.params, "url") : undefined;
    if (action === "navigate" && !value) throw new Error("Browser URL is required");
    const result = await runtime.browser(
      target.surface.id,
      action as "navigate" | "reload" | "url" | "snapshot" | "console" | "screenshot",
      value,
    );
    const url = resultUrl(result);
    if (url) runtime.setBrowserUrl(target.workspace.id, target.surface.id, url);
    return result;
  }

  const target = resolveTarget(snapshot, request.params);
  switch (request.action) {
    case "identify":
      return describeSurface(target, runtime);
    case "focus":
      runtime.focus(target.workspace.id, target.surface.id);
      return { workspaceId: target.workspace.id, surfaceId: target.surface.id };
    case "split":
    case "spawn-subagent": {
      if (target.surface.type !== "leaf") throw new Error("Only terminal surfaces can be split");
      const direction = stringParam(request.params, "direction");
      if (direction !== "horizontal" && direction !== "vertical") {
        throw new Error("Invalid split direction");
      }
      const command = stringParam(request.params, "command");
      if (request.action === "spawn-subagent" && !command) {
        throw new Error("Subagent command is required");
      }
      const metadata: LeafLaunchMetadata | undefined = request.action === "spawn-subagent"
        ? {
            agentRole: "subagent",
            parentSurfaceId:
              stringParam(request.params, "parent_surface_id") ?? target.surface.id,
            agentLabel: stringParam(request.params, "label") ?? "subagent",
          }
        : undefined;
      const surfaceId = runtime.split(
        target.workspace.id,
        target.surface.id,
        direction,
        command,
        metadata,
      );
      runtime.focus(target.workspace.id, surfaceId);
      return { workspaceId: target.workspace.id, surfaceId };
    }
    case "send-text": {
      if (target.surface.type !== "leaf") throw new Error("Target is not a terminal surface");
      const text = stringParam(request.params, "text");
      if (text === undefined) throw new Error("Text is required");
      await runtime.write(target.surface.id, text);
      return { workspaceId: target.workspace.id, surfaceId: target.surface.id };
    }
    case "read-screen": {
      if (target.surface.type !== "leaf") throw new Error("Target is not a terminal surface");
      const rowsValue = request.params.rows;
      const rows = typeof rowsValue === "number" && Number.isInteger(rowsValue) && rowsValue >= 1 && rowsValue <= 500
        ? rowsValue
        : 24;
      return {
        workspaceId: target.workspace.id,
        surfaceId: target.surface.id,
        text: runtime.readVisibleText(target.surface.id, rows).join("\n"),
      };
    }
    default:
      throw new Error(`Unknown control action: ${request.action}`);
  }
};
