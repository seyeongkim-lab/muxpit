import test from "node:test";
import assert from "node:assert/strict";

import { decodeOsc52ClipboardWrite } from "../src/utils/osc52.ts";

const encode = (text: string): string =>
  Buffer.from(text, "utf-8").toString("base64");

test("decodes a clipboard write payload", () => {
  const data = `c;${encode("hello world")}`;
  assert.equal(decodeOsc52ClipboardWrite(data), "hello world");
});

test("decodes UTF-8 text", () => {
  const data = `c;${encode("안녕하세요 🌏")}`;
  assert.equal(decodeOsc52ClipboardWrite(data), "안녕하세요 🌏");
});

test("handles an empty selection parameter", () => {
  const data = `;${encode("from-empty-pc")}`;
  assert.equal(decodeOsc52ClipboardWrite(data), "from-empty-pc");
});

test("refuses clipboard read requests", () => {
  assert.equal(decodeOsc52ClipboardWrite("c;?"), null);
});

test("returns null for an empty payload", () => {
  assert.equal(decodeOsc52ClipboardWrite("c;"), null);
});

test("returns null when no selection separator is present", () => {
  assert.equal(decodeOsc52ClipboardWrite("c"), null);
});

test("returns null for malformed base64", () => {
  assert.equal(decodeOsc52ClipboardWrite("c;@@@not-base64@@@"), null);
});
