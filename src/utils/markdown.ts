// Minimal markdown parser for agent chat messages. Covers the subset agents
// actually emit — fenced code, inline code, bold/italic, headings, lists
// (one nesting level), blockquotes, pipe tables, links — and degrades to
// plain paragraphs for everything else. Streaming safe: an unterminated code
// fence is treated as an open code block. The output is a small AST rendered
// to React elements (never innerHTML), so model output cannot inject markup.

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "link"; text: string; href: string };

export interface MarkdownListItem {
  children: MarkdownInline[];
  sub?: { ordered: boolean; items: MarkdownInline[][] };
}

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "heading"; level: number; children: MarkdownInline[] }
  | { type: "codeBlock"; language: string; text: string }
  | { type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { type: "blockquote"; children: MarkdownInline[] }
  | { type: "table"; header: MarkdownInline[][]; rows: MarkdownInline[][][] };

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

// Items indented by two or more spaces nest under the previous top item —
// one level only, which is as deep as agent answers go in practice.
const LIST_ITEM_RE = /^( *)([-*]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_OPEN_RE = /^```(\S*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const BLOCKQUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

const orderedMarker = (marker: string): boolean => /^\d/.test(marker);

const isTableStart = (lines: string[], index: number): boolean => {
  const next = lines[index + 1];
  return lines[index].includes("|")
    && next !== undefined
    && next.includes("|")
    && next.includes("-")
    && TABLE_SEPARATOR_RE.test(next);
};

const splitTableCells = (line: string): string[] => {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
};

const isBlockStart = (line: string): boolean =>
  FENCE_OPEN_RE.test(line)
  || HEADING_RE.test(line)
  || LIST_ITEM_RE.test(line)
  || BLOCKQUOTE_RE.test(line);

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
    if (BLOCKQUOTE_RE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const quote = lines[index].match(BLOCKQUOTE_RE);
        if (!quote) break;
        quoted.push(quote[1]);
        index += 1;
      }
      blocks.push({ type: "blockquote", children: parseMarkdownInline(quoted.join("\n")) });
      continue;
    }
    if (isTableStart(lines, index)) {
      const header = splitTableCells(lines[index]).map(parseMarkdownInline);
      index += 2;
      const rows: MarkdownInline[][][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableCells(lines[index]).map(parseMarkdownInline));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const listMatch = line.match(LIST_ITEM_RE);
    if (listMatch) {
      const ordered = orderedMarker(listMatch[2]);
      const items: MarkdownListItem[] = [];
      while (index < lines.length) {
        const item = lines[index].match(LIST_ITEM_RE);
        if (!item) break;
        const nested = item[1].length >= 2 && items.length > 0;
        if (nested) {
          const parent = items[items.length - 1];
          const sub = parent.sub ?? { ordered: orderedMarker(item[2]), items: [] };
          sub.items.push(parseMarkdownInline(item[3]));
          parent.sub = sub;
        } else {
          if (orderedMarker(item[2]) !== ordered) break;
          items.push({ children: parseMarkdownInline(item[3]) });
        }
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !isBlockStart(lines[index])
      && !isTableStart(lines, index)
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseMarkdownInline(paragraph.join("\n")) });
    continue;
  }
  return blocks;
};
