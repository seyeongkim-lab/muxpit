import test from "node:test";
import assert from "node:assert/strict";

import { getResolvedTheme, getThemeByName, type CustomColors } from "../src/themes.ts";

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
