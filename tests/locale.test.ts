import test from "node:test";
import assert from "node:assert/strict";

import {
  installNavigatorLocaleFallback,
  normalizeLocaleTag,
  normalizeLocaleTags,
} from "../src/utils/locale.ts";

test("locale normalization maps POSIX C locales to a valid browser locale", () => {
  assert.equal(normalizeLocaleTag("C"), "en-US");
  assert.equal(normalizeLocaleTag("C.UTF-8"), "en-US");
  assert.equal(normalizeLocaleTag("POSIX"), "en-US");
});

test("locale normalization converts underscore and encoding forms", () => {
  assert.equal(normalizeLocaleTag("ko_KR.UTF-8"), "ko-KR");
  assert.equal(normalizeLocaleTag("en_US"), "en-US");
});

test("locale list normalization deduplicates and keeps a fallback", () => {
  assert.deepEqual(normalizeLocaleTags(["C", "en_US.UTF-8", "en-US"]), ["en-US"]);
  assert.deepEqual(normalizeLocaleTags([]), ["en-US"]);
});

test("navigator locale fallback patches invalid runtime locale values", () => {
  const nav = { language: "C", languages: ["C"] } as Navigator;

  assert.equal(installNavigatorLocaleFallback(nav), true);
  assert.equal(nav.language, "en-US");
  assert.deepEqual(nav.languages, ["en-US"]);
});

test("navigator locale fallback leaves valid locale values untouched", () => {
  const nav = { language: "ko-KR", languages: ["ko-KR", "en-US"] } as Navigator;

  assert.equal(installNavigatorLocaleFallback(nav), false);
  assert.equal(nav.language, "ko-KR");
  assert.deepEqual(nav.languages, ["ko-KR", "en-US"]);
});
