// Pure helpers that turn a tool call's structured input into the compact
// forms the timeline renders: a one-line summary, an Edit diff, or a
// TodoWrite checklist. Field names follow the shapes the claude CLI actually
// writes to session transcripts (command, file_path, pattern, todos, …).

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

// The one line that identifies the call, like the CLI's `Bash(cargo test)`.
export const toolSummary = (name: string, input: unknown): string | null => {
  const object = objectValue(input);
  if (!object) return null;
  if (name === "Grep") {
    const pattern = stringValue(object.pattern);
    const path = stringValue(object.path);
    if (!pattern) return null;
    return path ? `${pattern} in ${path}` : pattern;
  }
  return stringValue(object.command)
    ?? stringValue(object.file_path)
    ?? stringValue(object.notebook_path)
    ?? stringValue(object.path)
    ?? stringValue(object.pattern)
    ?? stringValue(object.url)
    ?? stringValue(object.query)
    ?? stringValue(object.description)
    ?? stringValue(object.skill)
    ?? null;
};

export interface ToolDiff {
  removed: string[];
  added: string[];
}

const MAX_DIFF_LINES = 40;

const cappedLines = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines.length <= MAX_DIFF_LINES) return lines;
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more lines`];
};

// Edit carries the change itself; render it as a removed/added hunk. Write is
// all insertion, so its content renders as an added-only hunk.
export const toolDiff = (name: string, input: unknown): ToolDiff | null => {
  const object = objectValue(input);
  if (!object) return null;
  if (name === "Edit") {
    const removed = stringValue(object.old_string);
    const added = stringValue(object.new_string);
    if (removed === undefined && added === undefined) return null;
    return {
      removed: removed ? cappedLines(removed) : [],
      added: added ? cappedLines(added) : [],
    };
  }
  if (name === "Write") {
    const content = stringValue(object.content);
    return content ? { removed: [], added: cappedLines(content) } : null;
  }
  return null;
};

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export const todoItems = (name: string, input: unknown): TodoItem[] | null => {
  if (name !== "TodoWrite") return null;
  const todos = objectValue(input)?.todos;
  if (!Array.isArray(todos)) return null;
  const items: TodoItem[] = [];
  for (const value of todos) {
    const todo = objectValue(value);
    const content = stringValue(todo?.content);
    if (!content) continue;
    const status = todo?.status;
    items.push({
      content,
      status: status === "in_progress" || status === "completed" ? status : "pending",
    });
  }
  return items.length > 0 ? items : null;
};

export const TODO_GLYPHS: Record<TodoItem["status"], string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
};
