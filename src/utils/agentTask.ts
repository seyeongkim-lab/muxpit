export type AgentTaskStatus = "working" | "waiting" | "done" | "error";

export interface AgentTask {
  id: string;
  workspaceId: string;
  surfaceId: string;
  source: string;
  label: string;
  status: AgentTaskStatus;
  updatedAt: number;
  acknowledged: boolean;
  parentSurfaceId?: string;
}

export type AgentTaskUpdate = Omit<AgentTask, "id" | "acknowledged">;

interface AgentTaskTargetNode {
  id?: string;
  children?: readonly AgentTaskTargetNode[];
}

interface AgentTaskTargetWorkspace {
  id: string;
  layout: AgentTaskTargetNode;
}

const normalizedEvent = (event: string | undefined): string =>
  event?.trim().toLowerCase().replace(/[_-]/g, "") ?? "";

export const agentTaskStatusFromEvent = (
  event: string | undefined,
  label?: string,
): AgentTaskStatus | null => {
  const name = normalizedEvent(event);
  if (name === "error" || name === "erroroccurred") return "error";
  if (name === "permissionrequest" || name === "notification") {
    return /\b(?:error|failed|failure)\b/i.test(label ?? "") ? "error" : "waiting";
  }
  if (name === "stop" || name === "subagentstop" || name === "sessionend") return "done";
  if (
    name === "sessionstart" ||
    name === "userpromptsubmit" ||
    name === "pretooluse" ||
    name === "subagentstart"
  ) {
    return "working";
  }
  return null;
};

export const agentTaskStatusFromTerminal = (
  kind: "active" | "ready",
  label: string,
): AgentTaskStatus => {
  if (/\b(?:error|failed|failure)\b/i.test(label)) return "error";
  if (/\b(?:done|complete|completed|finished)\b/i.test(label)) return "done";
  return kind === "active" ? "working" : "waiting";
};

export const reduceAgentTask = (
  tasks: readonly AgentTask[],
  update: AgentTaskUpdate,
): AgentTask[] => {
  const id = `${update.workspaceId}:${update.surfaceId}`;
  const next: AgentTask = { ...update, id, acknowledged: false };
  return [next, ...tasks.filter((task) => task.id !== id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 200);
};

export const attentionAgentTasks = (tasks: readonly AgentTask[]): AgentTask[] =>
  tasks
    .filter((task) => task.status !== "working" && !task.acknowledged)
    .sort((left, right) => right.updatedAt - left.updatedAt);

const layoutContainsSurface = (node: AgentTaskTargetNode, surfaceId: string): boolean =>
  node.id === surfaceId ||
  node.children?.some((child) => layoutContainsSurface(child, surfaceId)) === true;

export const resolveAgentTaskTarget = (
  task: AgentTask,
  workspaces: readonly AgentTaskTargetWorkspace[],
): { workspaceId: string; surfaceId: string } | null => {
  const workspace = workspaces.find((candidate) => candidate.id === task.workspaceId);
  if (!workspace || !layoutContainsSurface(workspace.layout, task.surfaceId)) return null;
  return { workspaceId: workspace.id, surfaceId: task.surfaceId };
};
