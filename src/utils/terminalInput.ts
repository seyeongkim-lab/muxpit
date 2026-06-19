import type { RuntimePlatform } from "./runtimePlatform";

export interface TerminalKeySnapshot {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
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
  | { kind: "allowNativeClipboard" }
  | { kind: "copySelection" }
  | { kind: "pasteClipboard" };

export type TerminalClipboardAction =
  | "none"
  | "copySelection"
  | "pasteClipboard"
  | "allowNativeClipboard"
  | "blockClipboardShortcut";

export const isTerminalCompositionKeyEvent = (event: TerminalKeySnapshot): boolean =>
  event.isComposing === true || event.key === "Process" || event.keyCode === 229;

export const isTerminalTextInputData = (data: string): boolean =>
  data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);

export interface TerminalInputBufferCleanupSchedule {
  enabled: boolean;
  data: string;
  textareaValue: string;
}

export interface TerminalInputBufferCleanupState {
  isComposing: boolean;
  textareaValue: string;
}

export const shouldScheduleTerminalInputBufferCleanup = ({
  enabled,
  data,
  textareaValue,
}: TerminalInputBufferCleanupSchedule): boolean =>
  enabled && isTerminalTextInputData(data) && textareaValue.length > 0;

export const shouldClearTerminalInputBuffer = ({
  isComposing,
  textareaValue,
}: TerminalInputBufferCleanupState): boolean =>
  !isComposing && textareaValue.length > 0;

const keyEquals = (event: TerminalKeySnapshot, key: string): boolean =>
  event.key.toLowerCase() === key;

const isCtrlShortcut = (event: TerminalKeySnapshot): boolean =>
  event.ctrlKey && !event.altKey && !event.metaKey;

const isMetaShortcut = (event: TerminalKeySnapshot): boolean =>
  event.metaKey && !event.ctrlKey && !event.altKey;

export const shouldReadTerminalSelectionForInput = (
  event: TerminalKeySnapshot,
): boolean =>
  event.type === "keydown" &&
  keyEquals(event, "c") &&
  (event.ctrlKey || event.metaKey);

export const getTerminalClipboardAction = (
  event: TerminalKeySnapshot,
  state: Pick<TerminalInputState, "hasSelection">,
  platform: RuntimePlatform,
): TerminalClipboardAction => {
  if (event.type !== "keydown") return "none";

  const ctrlShortcut = isCtrlShortcut(event);
  const ctrlShiftShortcut = ctrlShortcut && event.shiftKey;
  const ctrlPlainShortcut = ctrlShortcut && !event.shiftKey;
  const metaPlainShortcut = isMetaShortcut(event) && !event.shiftKey;

  switch (platform) {
    case "macos":
      if (metaPlainShortcut && (keyEquals(event, "c") || keyEquals(event, "v"))) {
        return "allowNativeClipboard";
      }
      return "none";
    case "linux":
      if (ctrlShiftShortcut && keyEquals(event, "c")) {
        return state.hasSelection ? "copySelection" : "blockClipboardShortcut";
      }
      if (ctrlShiftShortcut && keyEquals(event, "v")) {
        return "allowNativeClipboard";
      }
      return "none";
    case "windows":
      if (ctrlShiftShortcut && keyEquals(event, "c")) {
        return state.hasSelection ? "copySelection" : "blockClipboardShortcut";
      }
      if (ctrlPlainShortcut && keyEquals(event, "c") && state.hasSelection) {
        return "copySelection";
      }
      if (ctrlShiftShortcut && keyEquals(event, "v")) {
        return "allowNativeClipboard";
      }
      if (ctrlPlainShortcut && keyEquals(event, "v")) {
        return "pasteClipboard";
      }
      return "none";
    case "unknown":
      if ((ctrlPlainShortcut || ctrlShiftShortcut) && keyEquals(event, "c")) {
        return state.hasSelection ? "copySelection" : "blockClipboardShortcut";
      }
      if (ctrlShiftShortcut && keyEquals(event, "v")) {
        return "allowNativeClipboard";
      }
      if (ctrlPlainShortcut && keyEquals(event, "v")) {
        return "pasteClipboard";
      }
      return "none";
  }
};

export const decideTerminalInput = (
  event: TerminalKeySnapshot,
  state: TerminalInputState,
  platform: RuntimePlatform,
): TerminalInputDecision => {
  if (isTerminalCompositionKeyEvent(event)) return { kind: "allowTerminalInput" };

  if (event.type !== "keydown") return { kind: "allowTerminalInput" };

  // Prefix mode active or history panel open -> the terminal must not consume keys.
  if (state.prefixActive || state.historyOpen) return { kind: "blockTerminalInput" };

  // Pressing the configured prefix key -> App handler activates prefix mode.
  if (state.prefixKeyMatches) return { kind: "blockTerminalInput" };

  switch (getTerminalClipboardAction(event, state, platform)) {
    case "copySelection":
      return { kind: "copySelection" };
    case "pasteClipboard":
      return { kind: "pasteClipboard" };
    case "allowNativeClipboard":
      return { kind: "allowNativeClipboard" };
    case "blockClipboardShortcut":
      return { kind: "blockTerminalInput" };
    case "none":
      break;
  }

  // Let Ctrl+Shift combos bubble to App shortcuts without reaching the terminal.
  if (event.ctrlKey && event.shiftKey) return { kind: "blockTerminalInput" };

  // Let Win/Meta key combos pass through to OS (e.g. Win+V clipboard history).
  if (event.metaKey) return { kind: "blockTerminalInput" };

  return { kind: "allowTerminalInput" };
};
