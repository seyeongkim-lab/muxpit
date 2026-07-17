export const DESKTOP_WORKBENCH_SELECTION_KEY = "muxpit-desktop-agent-selection-v1";
const LEGACY_WORKBENCH_PREFIX = "muxpit-desktop-agent-workbench-v1:";

export interface DesktopStorage {
  readonly length: number;
  key: (index: number) => string | null;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface DesktopWorkbenchSelection<Provider extends string = string> {
  targetKey: string;
  provider: Provider;
  sessionId: string | null;
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const loadDesktopWorkbenchSelection = <Provider extends string>(
  storage: DesktopStorage,
  providers: readonly Provider[],
): DesktopWorkbenchSelection<Provider> | undefined => {
  try {
    const value = objectValue(JSON.parse(
      storage.getItem(DESKTOP_WORKBENCH_SELECTION_KEY) ?? "null",
    ));
    if (
      value?.version !== 1
      || typeof value.targetKey !== "string"
      || !providers.includes(value.provider as Provider)
      || !(typeof value.sessionId === "string" || value.sessionId === null)
    ) return undefined;
    return {
      targetKey: value.targetKey,
      provider: value.provider as Provider,
      sessionId: value.sessionId,
    };
  } catch {
    return undefined;
  }
};

export const saveDesktopWorkbenchSelection = <Provider extends string>(
  storage: DesktopStorage,
  selection: DesktopWorkbenchSelection<Provider>,
): void => {
  try {
    storage.setItem(DESKTOP_WORKBENCH_SELECTION_KEY, JSON.stringify({
      version: 1,
      ...selection,
    }));
  } catch {
    // The live workbench remains usable when storage is unavailable.
  }
};

export const desktopLegacySnapshotKeys = (
  storage: DesktopStorage,
  targetPrefixes: readonly string[],
): string[] => {
  const prefixes = targetPrefixes.map((prefix) => `${LEGACY_WORKBENCH_PREFIX}${prefix}`);
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys.sort();
};
