import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOsc7Cwd, parseTerminalOutputEvents } from "../src/utils/terminalOutput.ts";

test("terminal output parser extracts OSC metadata events", () => {
  const data = [
    "\x1b]7;file://host/home/me/project%20one\x07",
    "\x1b]2;vim main.ts\x1b\\",
    "\x1b]777;notify;Build;Done\x07",
    "\x1b]777;git;feature/test\x07",
    "\x1b]777;cmd;pnpm test\x07",
  ].join("");

  assert.deepEqual(parseTerminalOutputEvents(data), [
    { type: "cwd", cwd: "/home/me/project one" },
    { type: "title", title: "vim main.ts" },
    { type: "notification", title: "Build", body: "Done" },
    { type: "gitBranch", branch: "feature/test" },
    { type: "historyCommand", command: "pnpm test" },
  ]);
});

test("terminal output parser normalizes Windows OSC 7 paths", () => {
  assert.equal(normalizeOsc7Cwd("/C:/Users/one/project"), "C:/Users/one/project");
});

test("terminal output parser maps empty git branch to null", () => {
  assert.deepEqual(parseTerminalOutputEvents("\x1b]777;git;\x07"), [
    { type: "gitBranch", branch: null },
  ]);
});
