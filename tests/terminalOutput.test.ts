import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeOsc7Cwd,
  parseTerminalOutputEvents,
  TerminalOutputParser,
} from "../src/utils/terminalOutput.ts";

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
  assert.equal(normalizeOsc7Cwd("/C:\\Users\\one\\project"), "C:\\Users\\one\\project");
  assert.equal(normalizeOsc7Cwd("/C:/Users/one/100% done"), "C:/Users/one/100% done");
  assert.equal(
    normalizeOsc7Cwd("/share/project%20one", { host: "server", platform: "windows" }),
    "\\\\server\\share\\project one",
  );
  assert.equal(
    normalizeOsc7Cwd("/C:\\Users\\one\\100%2Fdone", { platform: "windows" }),
    "C:\\Users\\one\\100%2Fdone",
  );
  assert.deepEqual(
    parseTerminalOutputEvents("\x1b]7;file://server/share/project%20one\x07", {
      platform: "windows",
    }),
    [{ type: "cwd", cwd: "\\\\server\\share\\project one" }],
  );
});

test("terminal output parser maps empty git branch to null", () => {
  assert.deepEqual(parseTerminalOutputEvents("\x1b]777;git;\x07"), [
    { type: "gitBranch", branch: null },
  ]);
});

test("terminal output parser buffers OSC metadata split across chunks", () => {
  const parser = new TerminalOutputParser({ platform: "linux" });

  assert.deepEqual(parser.parse("\x1b]7;file://host/home/me/"), []);
  assert.deepEqual(parser.parse("project\x07"), [
    { type: "cwd", cwd: "/home/me/project" },
  ]);
  assert.deepEqual(parser.parse("\x1b]777;cmd;pnpm"), []);
  assert.deepEqual(parser.parse(" test\x1b\\"), [
    { type: "historyCommand", command: "pnpm test" },
  ]);
});
