import test from "node:test";
import assert from "node:assert/strict";

import {
  WEBGL_RENDERER_COMPATIBILITY_VERSION,
  shouldResetSavedWebglRenderer,
  storedBoolean,
  useSettingsStore,
} from "../src/stores/settings.ts";

test("storedBoolean only accepts persisted true booleans", () => {
  assert.equal(storedBoolean(true), true);
  assert.equal(storedBoolean(false), false);
  assert.equal(storedBoolean("true"), false);
  assert.equal(storedBoolean("false"), false);
  assert.equal(storedBoolean(1), false);
  assert.equal(storedBoolean(null), false);
});

test("saved WebGL renderer settings are reset once on Windows", () => {
  assert.equal(shouldResetSavedWebglRenderer(undefined, "Win32"), true);
  assert.equal(
    shouldResetSavedWebglRenderer(WEBGL_RENDERER_COMPATIBILITY_VERSION, "Win32"),
    false,
  );
  assert.equal(shouldResetSavedWebglRenderer(undefined, "MacIntel"), false);
  assert.equal(shouldResetSavedWebglRenderer(undefined, "Linux x86_64"), false);
});

test("addCustomTheme dedupes names and selects the new theme", () => {
  const first = useSettingsStore.getState().addCustomTheme("Mine", { background: "#123456" });
  const second = useSettingsStore.getState().addCustomTheme("Mine", { background: "#654321" });
  assert.equal(first, "Mine");
  assert.equal(second, "Mine 2");
  assert.equal(useSettingsStore.getState().themeName, "Mine 2");
});

test("removeCustomTheme drops overrides and resets the active selection", () => {
  useSettingsStore.getState().addCustomTheme("Temp", { background: "#000000" });
  useSettingsStore.getState().setCustomColor("Temp", "background", "#ffffff");
  assert.ok(useSettingsStore.getState().customColors["Temp"]);

  useSettingsStore.getState().removeCustomTheme("Temp");
  const state = useSettingsStore.getState();
  assert.equal(state.customThemes.some((t) => t.name === "Temp"), false);
  assert.equal(state.customColors["Temp"], undefined);
  assert.notEqual(state.themeName, "Temp");
});
