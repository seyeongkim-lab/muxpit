import test from "node:test";
import assert from "node:assert/strict";

import { getResolvedTheme, getThemeByName, type CustomColors, type ThemeEntry } from "../src/themes.ts";

test("terminal theme resolution keeps base colors and applies custom overrides", () => {
  const themeName = "Catppuccin Mocha";
  const customColors: CustomColors = {
    [themeName]: {
      background: "#000000",
      cursor: "#ffffff",
    },
  };

  const resolved = getResolvedTheme(themeName, customColors);

  assert.equal(resolved.background, "#000000");
  assert.equal(resolved.cursor, "#ffffff");
  assert.equal(resolved.foreground, getThemeByName(themeName).theme.foreground);
});

test("Tokyo Night Storm ships as a built-in theme", () => {
  const entry = getThemeByName("Tokyo Night Storm");
  assert.equal(entry.name, "Tokyo Night Storm");
  assert.equal(entry.theme.background, "#24283b");
});

test("Windows Terminal theme matches the shell surface palette", () => {
  const entry = getThemeByName("Windows Terminal");
  assert.equal(entry.theme.background, "#1e2335");
  assert.equal(entry.theme.foreground, "#d7ddf7");
});

test("resolution prefers a custom theme and layers overrides on it", () => {
  const customThemes: ThemeEntry[] = [
    { name: "My Theme", theme: { background: "#111111", foreground: "#eeeeee" } },
  ];
  const customColors: CustomColors = { "My Theme": { foreground: "#00ff00" } };

  const resolved = getResolvedTheme("My Theme", customColors, customThemes);
  assert.equal(resolved.background, "#111111");
  assert.equal(resolved.foreground, "#00ff00");

  // Unknown names still fall back to the first built-in theme.
  assert.equal(getThemeByName("nope", customThemes).name, getThemeByName("").name);
});
