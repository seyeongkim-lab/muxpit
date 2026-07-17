import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileActiveSession,
  type TmuxAttachSnapshot,
  type TmuxSessionSnapshot,
} from "../src/utils/tmuxSessionState.ts";

const ctx: TmuxAttachSnapshot = {
  wrapperSession: "muxpit-host",
  activeSession: "muxpit-host",
};

test("tmux active session follows the attached non-wrapper session", () => {
  const sessions: TmuxSessionSnapshot[] = [
    { id: "$0", name: "muxpit-host", attached: false, windows: 1, activity: 10 },
    { id: "$1", name: "work", attached: true, windows: 1, activity: 20 },
  ];

  assert.equal(reconcileActiveSession(ctx, sessions).activeSession, "$1");
});

test("tmux active session is preserved when no attached session is visible", () => {
  const sessions: TmuxSessionSnapshot[] = [
    { id: "$0", name: "muxpit-host", attached: false, windows: 1, activity: 10 },
    { id: "$1", name: "work", attached: false, windows: 1, activity: 20 },
  ];

  assert.equal(reconcileActiveSession(ctx, sessions).activeSession, "muxpit-host");
});
