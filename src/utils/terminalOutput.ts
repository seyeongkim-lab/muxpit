export type TerminalOutputEvent =
  | { type: "cwd"; cwd: string }
  | { type: "title"; title: string }
  | { type: "notification"; title: string; body: string }
  | { type: "gitBranch"; branch: string | null }
  | { type: "historyCommand"; command: string };

export const normalizeOsc7Cwd = (rawPath: string): string => {
  const decoded = decodeURIComponent(rawPath);
  if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1);
  return decoded;
};

export const parseTerminalOutputEvents = (data: string): TerminalOutputEvent[] => {
  const events: TerminalOutputEvent[] = [];

  // OSC 7: current working directory
  // Format: \e]7;file://hostname/path\a  or \e]7;file://hostname/path\e\\
  const osc7Re = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  let match;
  while ((match = osc7Re.exec(data)) !== null) {
    const cwd = normalizeOsc7Cwd(match[1]);
    if (cwd) events.push({ type: "cwd", cwd });
  }

  // OSC 0/2: terminal title. Some full-screen CLIs use this for session context.
  const titleRe = /\x1b\](?:0|2);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((match = titleRe.exec(data)) !== null) {
    const title = match[1].trim();
    if (title) events.push({ type: "title", title });
  }

  // OSC 777: custom notifications and metadata
  const notifyRe = /\x1b\]777;notify;([^;]*);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((match = notifyRe.exec(data)) !== null) {
    events.push({ type: "notification", title: match[1], body: match[2] });
  }

  const gitRe = /\x1b\]777;git;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((match = gitRe.exec(data)) !== null) {
    const branch = match[1].trim();
    events.push({ type: "gitBranch", branch: branch || null });
  }

  const commandRe = /\x1b\]777;cmd;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((match = commandRe.exec(data)) !== null) {
    const command = match[1];
    if (command) events.push({ type: "historyCommand", command });
  }

  return events;
};
