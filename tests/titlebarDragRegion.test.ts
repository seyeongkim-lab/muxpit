import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Tauri drag regions own the titlebar double-click behavior", () => {
  const sources = [
    "../src/App.tsx",
    "../src/components/TopDashboardBar.tsx",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

  const dragRegionTags = sources.flatMap((source) =>
    source.match(/<[^>]*data-tauri-drag-region[^>]*>/g) ?? [],
  );

  assert.ok(dragRegionTags.length > 0);
  assert.equal(
    dragRegionTags.some((tag) => tag.includes("onDoubleClick")),
    false,
  );
});
