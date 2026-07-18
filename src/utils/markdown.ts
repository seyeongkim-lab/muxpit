// Minimal markdown parser for agent chat messages. Covers the subset agents
// actually emit — fenced code, inline code, bold/italic, headings, lists,
// links — and degrades to plain paragraphs for everything else. Streaming
// safe: an unterminated code fence is treated as an open code block. The
// output is a small AST rendered to React elements (never innerHTML), so
// model output cannot inject markup.

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "link"; text: string; href: string };

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "heading"; level: number; children: MarkdownInline[] }
  | { type: "codeBlock"; language: string; text: string }
  | { type: "list"; ordered: boolean; items: MarkdownInline[][] };

const INLINE_TOKEN_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^()\s]+\))/;

export const parseMarkdownInline = (text: string): MarkdownInline[] => {
  const nodes: MarkdownInline[] = [];
  let rest = text;
  while (rest) {
    const match = INLINE_TOKEN_RE.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push({ type: "text", text: rest });
      break;
    }
    if (match.index > 0) nodes.push({ type: "text", text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push({ type: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      nodes.push({ type: "strong", children: parseMarkdownInline(token.slice(2, -2)) });
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^()\s]+)\)$/);
      if (link) nodes.push({ type: "link", text: link[1], href: link[2] });
      else nodes.push({ type: "text", text: token });
    } else {
      nodes.push({ type: "em", children: parseMarkdownInline(token.slice(1, -1)) });
    }
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
};

const UNORDERED_ITEM_RE = /^\s{0,3}[-*]\s+/;
const ORDERED_ITEM_RE = /^\s{0,3}\d+[.)]\s+/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_OPEN_RE = /^```(\S*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;

const isBlockStart = (line: string): boolean =>
  FENCE_OPEN_RE.test(line)
  || HEADING_RE.test(line)
  || UNORDERED_ITEM_RE.test(line)
  || ORDERED_ITEM_RE.test(line);

export const parseMarkdown = (text: string): MarkdownBlock[] => {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(FENCE_OPEN_RE);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_CLOSE_RE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "codeBlock", language: fence[1], text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseMarkdownInline(heading[2]),
      });
      index += 1;
      continue;
    }
    if (UNORDERED_ITEM_RE.test(line) || ORDERED_ITEM_RE.test(line)) {
      const ordered = ORDERED_ITEM_RE.test(line);
      const itemRe = ordered ? ORDERED_ITEM_RE : UNORDERED_ITEM_RE;
      const items: MarkdownInline[][] = [];
      while (index < lines.length && itemRe.test(lines[index])) {
        items.push(parseMarkdownInline(lines[index].replace(itemRe, "")));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseMarkdownInline(paragraph.join("\n")) });
  }
  return blocks;
};
