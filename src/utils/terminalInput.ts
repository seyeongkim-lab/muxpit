export interface TerminalKeySnapshot {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface TerminalInputState {
  prefixActive: boolean;
  historyOpen: boolean;
  prefixKeyMatches: boolean;
  hasSelection: boolean;
}

export type TerminalInputDecision =
  | { kind: "allowTerminalInput" }
  | { kind: "blockTerminalInput" }
  | { kind: "copySelection" }
  | { kind: "pasteClipboard" };

export const decideTerminalInput = (
  event: TerminalKeySnapshot,
  state: TerminalInputState,
): TerminalInputDecision => {
  // Let Ctrl+Shift combos bubble to App shortcuts without reaching the terminal.
  if (event.ctrlKey && event.shiftKey) return { kind: "blockTerminalInput" };

  // Let Win/Meta key combos pass through to OS (e.g. Win+V clipboard history).
  if (event.metaKey) return { kind: "blockTerminalInput" };

  if (event.type !== "keydown") return { kind: "allowTerminalInput" };

  // Prefix mode active or history panel open -> the terminal must not consume keys.
  if (state.prefixActive || state.historyOpen) return { kind: "blockTerminalInput" };

  // Pressing the configured prefix key -> App handler activates prefix mode.
  if (state.prefixKeyMatches) return { kind: "blockTerminalInput" };

  if (event.ctrlKey && event.key === "c" && state.hasSelection) {
    return { kind: "copySelection" };
  }

  if (event.ctrlKey && event.key === "v") {
    return { kind: "pasteClipboard" };
  }

  return { kind: "allowTerminalInput" };
};
