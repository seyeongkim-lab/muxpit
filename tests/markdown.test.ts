import test from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown, parseMarkdownInline } from "../src/utils/markdown.ts";
import { claudeInterruptLine } from "../src/mobile/agentProtocol.ts";

test("plain text becomes a single paragraph preserving line breaks", () => {
  const blocks = parseMarkdown("hello\nworld");
  assert.deepEqual(blocks, [
    { type: "paragraph", children: [{ type: "text", text: "hello\nworld" }] },
  ]);
});

test("fenced code blocks keep their content and language", () => {
  const blocks = parseMarkdown("before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter");
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[1], { type: "codeBlock", language: "ts", text: "const a = 1;\nconst b = 2;" });
});

test("an unterminated fence swallows the rest as code (streaming safe)", () => {
  const blocks = parseMarkdown("```py\nprint(1)\nprint(2)");
  assert.deepEqual(blocks, [{ type: "codeBlock", language: "py", text: "print(1)\nprint(2)" }]);
});

test("markdown inside a code fence is not formatted", () => {
  const blocks = parseMarkdown("```\n**not bold**\n- not a list\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "codeBlock");
});

test("headings parse with their level", () => {
  const blocks = parseMarkdown("## Title");
  assert.deepEqual(blocks, [
    { type: "heading", level: 2, children: [{ type: "text", text: "Title" }] },
  ]);
});

test("unordered and ordered lists group their items", () => {
  const blocks = parseMarkdown("- one\n- two\n\n1. first\n2. second");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "list");
  assert.equal((blocks[0] as { ordered: boolean }).ordered, false);
  assert.equal((blocks[0] as { items: unknown[] }).items.length, 2);
  assert.equal((blocks[1] as { ordered: boolean }).ordered, true);
});

test("inline code, bold, italic, and links tokenize", () => {
  assert.deepEqual(parseMarkdownInline("run `npm test` now"), [
    { type: "text", text: "run " },
    { type: "code", text: "npm test" },
    { type: "text", text: " now" },
  ]);
  assert.deepEqual(parseMarkdownInline("**bold** and *em*"), [
    { type: "strong", children: [{ type: "text", text: "bold" }] },
    { type: "text", text: " and " },
    { type: "em", children: [{ type: "text", text: "em" }] },
  ]);
  assert.deepEqual(parseMarkdownInline("see [docs](https://example.com)"), [
    { type: "text", text: "see " },
    { type: "link", text: "docs", href: "https://example.com" },
  ]);
});

test("stray asterisks and backticks fall through as text", () => {
  assert.deepEqual(parseMarkdownInline("a * b and ` c"), [
    { type: "text", text: "a * b and ` c" },
  ]);
});

test("claude interrupt line is a stream-json control request", () => {
  const parsed = JSON.parse(claudeInterruptLine("interrupt-1")) as Record<string, unknown>;
  assert.equal(parsed.type, "control_request");
  assert.equal(parsed.request_id, "interrupt-1");
  assert.deepEqual(parsed.request, { subtype: "interrupt" });
});
