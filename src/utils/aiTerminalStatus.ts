export type AiTerminalStatusKind = "active" | "ready";

export interface AiTerminalStatus {
  label: string;
  kind: AiTerminalStatusKind;
  updatedAt: number;
}

const AI_NAME_RE = /\b(?:claude(?: code)?|codex|gemini|copilot)\b/i;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const BOX_RE = /[\u2500-\u257f]/g;
const LEADING_STATUS_RE =
  /^[\s>|:;,\-.()[\]{}]*[\u2022\u25cf\u25cb\u25c9\u25ce\u25c6\u2713\u2714\u2800-\u28ff|/\\\-+*~.oO]*\s*/u;
const READY_MARKER_ONLY_RE =
  /^[\s>|:;,\-.()[\]{}]*[\u2022\u25cf\u25cb\u25c9\u25ce\u25c6\u2713\u2714]\s*$/u;

const READY_RE_LIST = [
  /\b(?:waiting|ready|idle|done|completed?|finished|awaiting|your turn|needs? input|input needed|press (?:enter|return)|approve|approval|confirm|permission requested|requires permission)\b/i,
  /(?:\ub300\uae30|\uc644\ub8cc|\uc785\ub825|\uc2b9\uc778|\ud655\uc778|\uad8c\ud55c)/u,
];

const ACTIVE_RE_LIST = [
  /\b(?:thinking|working|running|reading|editing|writing|searching|analy[sz]ing|implementing|fixing|testing|building|planning|checking|processing|calling|using tool|applying patch)\b/i,
  /(?:\uc791\uc5c5|\uc218\uc815|\uac80\ud1a0|\ubd84\uc11d|\ud14c\uc2a4\ud2b8|\ube4c\ub4dc|\uc2e4\ud589|\uac80\uc0c9|\uc791\uc131|\ucc98\ub9ac)/u,
];

const NOISE_RE_LIST = [
  /^\s*$/,
  /^\s*(?:tokens?|context|model|cwd|branch|press ctrl|esc to|help)\b/i,
  /^\s*(?:[0-9]+%|[0-9]+\/[0-9]+)\s*$/,
];

const matchesAny = (value: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(value));

const normalizeLine = (line: string): string =>
  line
    .replace(ANSI_RE, "")
    .replace(CONTROL_RE, "")
    .replace(BOX_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

export const compactAiStatusLabel = (value: string, maxLength = 42): string => {
  const normalized = normalizeLine(value)
    .replace(LEADING_STATUS_RE, "")
    .replace(/^(?:claude(?: code)?|codex|gemini|copilot)\s*[:>\-]\s*/i, "")
    .replace(/^permission requested\s*:\s*/i, "permission: ")
    .replace(/^prompt completed$/i, "done")
    .trim();
  const label = normalized || "ready";
  if (label.length <= maxLength) return label;
  return `${label.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const candidateLines = (lines: readonly string[]): string[] =>
  lines
    .map(normalizeLine)
    .filter((line) => line.length > 0 && !matchesAny(line, NOISE_RE_LIST));

export const parseAiTerminalStatus = (
  lines: readonly string[],
  updatedAt = Date.now(),
): AiTerminalStatus | null => {
  const candidates = candidateLines(lines);

  for (let i = candidates.length - 1; i >= 0; i--) {
    const line = candidates[i];
    if (matchesAny(line, READY_RE_LIST) || READY_MARKER_ONLY_RE.test(line)) {
      return {
        label: READY_MARKER_ONLY_RE.test(line) ? "ready" : compactAiStatusLabel(line),
        kind: "ready",
        updatedAt,
      };
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const line = candidates[i];
    if (matchesAny(line, ACTIVE_RE_LIST)) {
      return {
        label: compactAiStatusLabel(line),
        kind: "active",
        updatedAt,
      };
    }
  }

  return null;
};

export const aiStatusFromHookNotification = (
  source: string | undefined,
  event: string | undefined,
  body: string | undefined,
  updatedAt = Date.now(),
): AiTerminalStatus | null => {
  if (!source || !AI_NAME_RE.test(source)) return null;
  const normalizedEvent = event?.trim().toLowerCase().replace(/[_-]/g, "");
  const rawLabel = body?.trim() || event?.trim() || "ready";

  if (normalizedEvent === "permissionrequest") {
    return {
      label: compactAiStatusLabel(rawLabel),
      kind: "ready",
      updatedAt,
    };
  }

  if (normalizedEvent === "stop" || normalizedEvent === "subagentstop" || normalizedEvent === "notification") {
    return {
      label: compactAiStatusLabel(rawLabel),
      kind: "ready",
      updatedAt,
    };
  }

  const parsed = parseAiTerminalStatus([source, rawLabel], updatedAt);
  return parsed;
};
