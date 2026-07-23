import test from "node:test";
import assert from "node:assert/strict";

import { isMarkdownFile, languageForFile, parseFileLink } from "../src/utils/fileLink.ts";

test("path-looking inline code parses with its line suffix stripped", () => {
  assert.deepEqual(parseFileLink("src/utils/markdown.ts:63"), {
    path: "src/utils/markdown.ts",
    line: 63,
  });
  assert.deepEqual(parseFileLink("src-tauri/src/monitor.rs:304-305"), {
    path: "src-tauri/src/monitor.rs",
    line: 304,
  });
  assert.deepEqual(parseFileLink("README.md"), { path: "README.md", line: undefined });
});

test("rooted paths link regardless of extension", () => {
  assert.equal(parseFileLink("/etc/hosts")?.path, "/etc/hosts");
  assert.equal(parseFileLink("~/notes/plan.md")?.path, "~/notes/plan.md");
  assert.equal(parseFileLink("./scripts/build")?.path, "./scripts/build");
  assert.equal(parseFileLink("C:\\Users\\one\\muxpit\\package.json")?.path, "C:\\Users\\one\\muxpit\\package.json");
});

test("non-path inline code stays plain", () => {
  assert.equal(parseFileLink("claude --resume"), null);
  assert.equal(parseFileLink("feature/session-list"), null);
  assert.equal(parseFileLink("v1.2"), null);
  assert.equal(parseFileLink("https://example.com/a.ts"), null);
  assert.equal(parseFileLink("npm install"), null);
  assert.equal(parseFileLink(".env"), null);
  assert.equal(parseFileLink("src/"), null);
});

test("dot-leading names still link when a separator shows they are paths", () => {
  assert.equal(parseFileLink("src/.env")?.path, "src/.env");
});

test("viewer language follows the file extension", () => {
  assert.equal(languageForFile("src/App.tsx"), "tsx");
  assert.equal(languageForFile("src-tauri/src/monitor.rs"), "rust");
  assert.equal(languageForFile("scripts/claude_sessions.py"), "python");
  assert.equal(languageForFile("notes/plan.md"), "markdown");
  assert.equal(languageForFile("data.bin"), null);
  assert.equal(isMarkdownFile("notes/plan.md"), true);
  assert.equal(isMarkdownFile("src/App.tsx"), false);
});
