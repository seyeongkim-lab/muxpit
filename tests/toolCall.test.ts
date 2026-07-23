import test from "node:test";
import assert from "node:assert/strict";

import { todoItems, toolDiff, toolSummary } from "../src/utils/toolCall.ts";

test("tool summaries show the argument that identifies the call", () => {
  assert.equal(toolSummary("Bash", { command: "cargo test", description: "Run tests" }), "cargo test");
  assert.equal(toolSummary("Read", { file_path: "src/main.rs" }), "src/main.rs");
  assert.equal(toolSummary("Grep", { pattern: "TODO", path: "src" }), "TODO in src");
  assert.equal(toolSummary("Glob", { pattern: "**/*.ts" }), "**/*.ts");
  assert.equal(toolSummary("WebSearch", { query: "tauri nsis" }), "tauri nsis");
  assert.equal(toolSummary("Mystery", { flag: true }), null);
  assert.equal(toolSummary("Bash", "not an object"), null);
});

test("Edit renders as a removed/added hunk and Write as added-only", () => {
  assert.deepEqual(toolDiff("Edit", { old_string: "a\nb", new_string: "c" }), {
    removed: ["a", "b"],
    added: ["c"],
  });
  assert.deepEqual(toolDiff("Write", { file_path: "x.txt", content: "hello" }), {
    removed: [],
    added: ["hello"],
  });
  assert.equal(toolDiff("Bash", { command: "ls" }), null);
});

test("oversized diffs are capped with a trailing count", () => {
  const long = Array.from({ length: 45 }, (_, index) => `line ${index}`).join("\n");
  const diff = toolDiff("Edit", { old_string: "", new_string: long });
  assert.ok(diff);
  assert.equal(diff.added.length, 41);
  assert.equal(diff.added[40], "… 5 more lines");
});

test("TodoWrite input becomes a checklist with normalized statuses", () => {
  const todos = todoItems("TodoWrite", {
    todos: [
      { content: "Ship it", status: "in_progress", activeForm: "Shipping it" },
      { content: "Test it", status: "completed" },
      { content: "Plan it", status: "unknown-status" },
      { status: "pending" },
    ],
  });
  assert.deepEqual(todos, [
    { content: "Ship it", status: "in_progress" },
    { content: "Test it", status: "completed" },
    { content: "Plan it", status: "pending" },
  ]);
  assert.equal(todoItems("Bash", { command: "ls" }), null);
});
