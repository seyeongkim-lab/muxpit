import type { PrefixKey } from "../stores/settings";

/** Check whether a KeyboardEvent matches the configured prefix key. */
export const matchesPrefixKey = (
  e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; key: string; code: string },
  prefixKey: PrefixKey,
): boolean => {
  if (prefixKey === "off") return false;
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;

  switch (prefixKey) {
    case "ctrl+b":
      return e.key === "b" || e.key === "B" || e.code === "KeyB";
    case "ctrl+a":
      return e.key === "a" || e.key === "A" || e.code === "KeyA";
    case "ctrl+space":
      return e.code === "Space";
    case "ctrl+q":
      return e.key === "q" || e.key === "Q" || e.code === "KeyQ";
    case "ctrl+\\":
      return e.key === "\\" || e.code === "Backslash";
    default:
      return false;
  }
};
