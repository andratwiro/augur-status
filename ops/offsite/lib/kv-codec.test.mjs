// The backup format, held from this end. The engine states the same contract and pins it
// in its own suite; this repo carries a copy of the codec on purpose (see the header of
// kv-codec.mjs), so it needs its own proof that the copy still speaks the same format.
//
// Everything is exercised with genuine non-UTF-8 bytes. A string with odd characters in
// it round-trips fine and would prove nothing: the failure is byte sequences that no text
// decoding can represent.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  KV_BACKUP_FORMAT, encodeKvValue, decodeKvValue, isBinaryKvValue,
  contentAddressOf, contentAddressMatches, contentAddressFailures,
} from "./kv-codec.mjs";

// A real PNG, and a real JPEG header — what a canvas paste actually stores.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xdb, 0x80, 0xfe]);
const bassetKey = (b) => "basset:" + createHash("sha256").update(b).digest("hex").slice(0, 40);

test("the format number matches the engine's", () => {
  assert.equal(KV_BACKUP_FORMAT, 2);
});

test("text rides as a plain string — a format-1 copy still reads", () => {
  for (const s of ['{"a":1}', "", "héllo wörld", "日本語 😀", "\uFEFF{}"]) {
    const v = encodeKvValue(Buffer.from(s, "utf8"));
    assert.equal(v, s, `${JSON.stringify(s)} is text and must stay text`);
    assert.ok(decodeKvValue(v).equals(Buffer.from(s, "utf8")));
  }
});

test("bytes that are not UTF-8 ride as the base64 marker and come back identical", () => {
  for (const [name, buf] of [["PNG", PNG], ["JPEG", JPEG]]) {
    const v = encodeKvValue(buf);
    assert.ok(isBinaryKvValue(v), `${name} must not be carried as a string`);
    assert.ok(decodeKvValue(v).equals(buf), `${name} must round-trip byte for byte`);
  }
  for (const bad of [[0x80], [0xc3], [0xc0, 0xaf], [0xff], [0xed, 0xa0, 0x80]]) {
    assert.ok(isBinaryKvValue(encodeKvValue(Buffer.from(bad))));
  }
});

test("an unreadable value stops a restore instead of resolving to a guess", () => {
  for (const junk of [null, 42, [], { nope: "AAA=" }, undefined, { b64: 7 }]) {
    assert.throws(() => decodeKvValue(junk), /unreadable backup value/);
  }
});

test("a content-addressed key is recognised, and nothing else is", () => {
  const k = bassetKey(PNG);
  assert.equal(contentAddressOf(k), k.slice(7));
  for (const other of ["statuses", "users:secrets", "basset:", "basset:zz", k + "x", "", null]) {
    assert.equal(contentAddressOf(other), null);
  }
});

test("the verdict is true, false, or not-applicable — never a guess", () => {
  const k = bassetKey(PNG);
  assert.equal(contentAddressMatches(k, PNG), true);
  assert.equal(contentAddressMatches(k, JPEG), false);
  assert.equal(contentAddressMatches("statuses", JPEG), null);
});

test("a copy taken by a text-mode exporter is caught, key by key", () => {
  // The corrupt copy, reproduced exactly: decode the image as text (what the old
  // exporters did), and that string is what the file holds.
  const k = bassetKey(PNG);
  const ruined = new TextDecoder("utf-8").decode(PNG);
  assert.notEqual(Buffer.from(ruined, "utf8").length, PNG.length, "and it is not even the same length");

  const bad = contentAddressFailures({ [k]: ruined, statuses: '{"x":"dev-ready"}' });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].key, k);
  assert.equal(bad[0].expected, k.slice(7));
  assert.notEqual(bad[0].actual, bad[0].expected);
});

test("a copy taken by a marker-aware exporter passes, and a good text value never trips it", () => {
  const doc = { [bassetKey(PNG)]: encodeKvValue(PNG), "c:/proto/": '[{"id":"t1"}]' };
  assert.deepEqual(contentAddressFailures(doc), []);
});

test("a value the codec cannot read counts as a failure, not as a pass", () => {
  // Silence here would be the guard failing open on the one shape it cannot judge.
  const bad = contentAddressFailures({ [bassetKey(PNG)]: { nope: "AAA=" } });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].actual, null);
  assert.match(bad[0].why, /unreadable backup value/);
});
