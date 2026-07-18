// One-time carry-over of webview localStorage written under the pre-rename
// name (wmux-*) to the current muxpit-* keys. The Rust side copies the legacy
// app-data directory (com.wmux.terminal) into the new identifier's directory,
// so a freshly upgraded install still holds the old localStorage entries under
// their wmux-* names. Without this, everything except settings/history — SSH
// hosts, launch profiles, sidebar layout, workspace sessions, agent workbench
// state, mobile hosts — would silently reset on upgrade.
//
// Runs before any store module reads localStorage (see main.tsx). Non-
// destructive: an existing muxpit-* key is never overwritten, mirroring the
// backend's copy_missing behaviour.

const LEGACY_PREFIX = "wmux-";
const CURRENT_PREFIX = "muxpit-";
const MIGRATED_FLAG = "muxpit-legacy-localstorage-migrated";

export const migrateLegacyStorage = (storage: Storage): void => {
  try {
    if (storage.getItem(MIGRATED_FLAG)) return;

    // Snapshot keys first: setItem below mutates the store while we iterate.
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
    }

    for (const legacyKey of legacyKeys) {
      const currentKey = CURRENT_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
      if (storage.getItem(currentKey) !== null) continue;
      const value = storage.getItem(legacyKey);
      if (value !== null) storage.setItem(currentKey, value);
    }

    storage.setItem(MIGRATED_FLAG, "1");
  } catch {
    // localStorage may be unavailable (private mode, non-browser host). Skip
    // migration rather than block boot; stores fall back to their defaults.
  }
};
