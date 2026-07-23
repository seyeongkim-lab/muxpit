// Detects file-path-looking strings in agent output so inline code like
// `src/utils/markdown.ts:63` can open the file viewer. Detection is
// deliberately conservative: an un-rooted candidate must carry an extension,
// otherwise git branches (`feature/foo`) and flag fragments would linkify.

const MAX_LINK_LENGTH = 512;

// `/abs`, `~/x`, `./x`, `../x`, or a Windows drive root.
const ROOTED_RE = /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)/;

// Path body: separator-joined segments of filename-safe characters.
const BODY_RE = /^[\w.@+-]+(?:[\\/][\w.@+-]+)*[\\/]?$/;

// Trailing `:12`, `:12:5`, or `:12-34` location suffix.
const LINE_SUFFIX_RE = /:(\d+)(?:[:-]\d+)?$/;

export interface FileLink {
  path: string;
  line?: number;
}

export const parseFileLink = (text: string): FileLink | null => {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_LINK_LENGTH) return null;
  if (trimmed.includes("://")) return null;

  const lineMatch = trimmed.match(LINE_SUFFIX_RE);
  const path = lineMatch ? trimmed.slice(0, -lineMatch[0].length) : trimmed;
  const line = lineMatch ? Number(lineMatch[1]) : undefined;

  const rooted = ROOTED_RE.test(path);
  const body = rooted ? path.replace(ROOTED_RE, "") : path;
  if (body && !BODY_RE.test(body)) return null;
  if (path.endsWith("/") || path.endsWith("\\")) return null;

  if (rooted) return body ? { path, line } : null;

  // Un-rooted: require an extension with at least one letter (so version
  // tokens like `v1.2` stay plain), and a separator for dot-leading names.
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot + 1) : "";
  if (!extension || extension.length > 8 || !/[A-Za-z]/.test(extension)) return null;
  if (!/[\\/]/.test(path) && dot < 1) return null;
  return { path, line };
};

// Maps a file name to the Prism grammar id used by the viewer. Grammars are
// registered in CodeHighlight.tsx; unknown extensions render unhighlighted.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonl: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  rs: "rust",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  go: "go",
  java: "java",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  conf: "ini",
  css: "css",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  md: "markdown",
  markdown: "markdown",
};

export const languageForFile = (path: string): string | null => {
  const name = path.split(/[\\/]/).pop() ?? "";
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
};

export const isMarkdownFile = (path: string): boolean =>
  languageForFile(path) === "markdown";
