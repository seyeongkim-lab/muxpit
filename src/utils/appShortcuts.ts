import type { RuntimePlatform } from "./runtimePlatform";
import { isTerminalCompositionKeyEvent, type TerminalKeySnapshot } from "./terminalInput.ts";

export type AppShortcutAction =
  | "none"
  | "toggleGrid"
  | "splitHorizontal"
  | "splitVertical"
  | "openBrowser"
  | "closePane"
  | "newWorkspace"
  | "closeWorkspace"
  | "toggleNotifications"
  | "toggleSettings"
  | "increaseFontSize"
  | "decreaseFontSize"
  | "resetFontSize";

export interface AppShortcutDecision {
  kind: AppShortcutAction;
}

const keyEquals = (event: TerminalKeySnapshot, key: string): boolean =>
  event.key.toLowerCase() === key;

const isCtrlShiftShortcut = (event: TerminalKeySnapshot): boolean =>
  event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;

const isLegacyCtrlShortcut = (event: TerminalKeySnapshot): boolean =>
  event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;

const isPlatformPrimaryShortcut = (
  event: TerminalKeySnapshot,
  platform: RuntimePlatform,
): boolean => {
  if (event.shiftKey || event.altKey) return false;
  if (platform === "macos") return event.metaKey && !event.ctrlKey;
  return event.ctrlKey && !event.metaKey;
};

export const isPlatformClipboardShortcut = (
  event: TerminalKeySnapshot,
  platform: RuntimePlatform,
): boolean => {
  if (event.type !== "keydown") return false;
  if (!keyEquals(event, "c") && !keyEquals(event, "v")) return false;

  if (platform === "macos") {
    return event.metaKey && !event.ctrlKey && !event.altKey;
  }
  if (platform === "linux") {
    return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
  }
  if (platform === "windows") {
    return event.ctrlKey && !event.altKey && !event.metaKey;
  }
  return (event.ctrlKey || event.metaKey) && !event.altKey;
};

export const decideAppShortcut = (
  event: TerminalKeySnapshot,
  platform: RuntimePlatform,
): AppShortcutDecision => {
  if (isTerminalCompositionKeyEvent(event)) return { kind: "none" };
  if (event.type !== "keydown") return { kind: "none" };
  if (isPlatformClipboardShortcut(event, platform)) return { kind: "none" };

  if (isCtrlShiftShortcut(event)) {
    if (keyEquals(event, "g")) return { kind: "toggleGrid" };
    if (keyEquals(event, "d")) return { kind: "splitHorizontal" };
    if (keyEquals(event, "e")) return { kind: "splitVertical" };
    if (keyEquals(event, "o")) return { kind: "openBrowser" };
    if (keyEquals(event, "w")) return { kind: "closePane" };
    if (keyEquals(event, "t")) return { kind: "newWorkspace" };
    if (keyEquals(event, "x")) return { kind: "closeWorkspace" };
    if (keyEquals(event, "i")) return { kind: "toggleNotifications" };
  }

  if (
    isLegacyCtrlShortcut(event) ||
    (platform === "macos" && isPlatformPrimaryShortcut(event, platform))
  ) {
    if (event.key === ",") return { kind: "toggleSettings" };
    if (event.key === "=" || event.key === "+") return { kind: "increaseFontSize" };
    if (event.key === "-") return { kind: "decreaseFontSize" };
    if (event.key === "0") return { kind: "resetFontSize" };
  }

  return { kind: "none" };
};
