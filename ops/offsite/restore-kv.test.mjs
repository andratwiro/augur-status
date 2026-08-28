// The backup round trip, driven through the real scripts: a namespace holding a real PNG
// is exported by kv-export.mjs, replayed by restore-kv.mjs into a second namespace, and
// the bytes on the far side are compared with the bytes that went in.
//
// No account, no network — scripts/lib/fake-kv-api.mjs stands in for the REST endpoint,
// and it stores bytes and refuses a non-string `value` exactly as the real one does. The
// two things being proven cannot be proven by reading the code: that a value which is not
// UTF-8 crosses both directions intact, and that a copy whose content-addressed keys no
// longer match their contents is REFUSED rather than written.
//
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeKvValue } from "./lib/kv-codec.mjs";
import { startFakeKvApi } from "./lib/fake-kv-api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESTORE = path.join(HERE, "restore-kv.mjs");
const EXPORT = path.join(HERE, "kv-export.mjs");

// A real PNG. Not a string with odd characters in it — the bug is about byte sequences
// that no text decoding can represent, and only genuine binary exercises that.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const KEY = "basset:" + createHash("sha256").update(PNG).digest("hex").slice(0, 40);
const TEXT_KEYS = { statuses: '{"x":"dev-ready"}', "c:/proto/": '[{"id":"t1"}]', "users:secrets": '{"a@b.test":"pbkdf2$…"}' };

const tmp = () => mkdtempSync(path.join(tmpdir(), "kv-drill-"));
const env = (base, extra = {}) => ({
  ...process.env,
  CLOUDFLARE_API_BASE: base,
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  AUGUR_KV_NS: "live-ns",
  ...extra,
});
// ASYNC on purpose. spawnSync blocks this process's event loop, and this process is the
// HTTP server the child talks to — a synchronous spawn deadlocks the pair.
const run = (script, args, e) => new Promise((resolve) => {
  execFile(process.execPath, [script, ...args], { encoding: "utf8", env: e },
    (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, out: stdout + stderr }));
});

// The namespace as it really is: text keys plus one raw image.
const liveKeys = () => new Map([
  ...Object.entries(TEXT_KEYS).map(([k, v]) => [k, Buffer.from(v, "utf8")]),
  [KEY, PNG],
]);

test("a canvas image survives export → restore → read-back, byte for byte", async () => {
  const src = await startFakeKvApi(liveKeys());
  const dst = await startFakeKvApi();
  try {
    const file = path.join(tmp(), "kv.json");
    const exported = await run(EXPORT, ["--out", file], env(src.base, { AUGUR_KV_NS: "src-ns" }));
    assert.equal(exported.status, 0, exported.out);
    assert.match(exported.out, /1 binary/, "the image cannot ride as text and the run says so");

    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.format, 2);
    assert.equal(doc.binary, 1);
    // Byte counts, not string lengths. One of the text values holds a `…`, which is one
    // character and three bytes, so the two numbers differ here on purpose.
    const textBytes = Buffer.byteLength(Object.values(TEXT_KEYS).join(""), "utf8");
    assert.notEqual(textBytes, Object.values(TEXT_KEYS).join("").length);
    assert.equal(doc.bytes, PNG.length + textBytes);

    const restored = await run(RESTORE, [file, "--into", "dst-ns", "--verify"], env(dst.base));
    assert.equal(restored.status, 0, restored.out);
    assert.match(restored.out, /verified 4\/4 keys/);

    // The assertion the whole exercise is for.
    assert.ok(dst.store.get(KEY).equals(PNG), "the restored image must be the image");
    // And the key is its own checksum, so the namespace agrees.
    assert.equal("basset:" + createHash("sha256").update(dst.store.get(KEY)).digest("hex").slice(0, 40), KEY);
    for (const [k, v] of Object.entries(TEXT_KEYS)) assert.equal(dst.store.get(k).toString("utf8"), v);
  } finally { await src.close(); await dst.close(); }
});

test("a copy whose image no longer matches its key is REFUSED, before anything is written", async () => {
  const dst = await startFakeKvApi();
  try {
    // The corrupt copy, made the way it was actually made: the image read as text.
    const file = path.join(tmp(), "kv.json");
    writeFileSync(file, JSON.stringify({ [KEY]: new TextDecoder("utf-8").decode(PNG), ...TEXT_KEYS }));

    const r = await run(RESTORE, [file, "--into", "dst-ns", "--verify"], env(dst.base));
    assert.equal(r.status, 1);
    assert.match(r.out, /CORRUPT/);
    assert.match(r.out, /are not the values their keys name/);
    assert.match(r.out, /--drop-corrupt/, "and it says what to do instead");
    assert.equal(dst.store.size, 0, "and NOTHING was written — not the good keys either");
  } finally { await dst.close(); }
});

test("--drop-corrupt restores everything else and leaves the key absent", async () => {
  const dst = await startFakeKvApi();
  try {
    const file = path.join(tmp(), "kv.json");
    writeFileSync(file, JSON.stringify({ [KEY]: new TextDecoder("utf-8").decode(PNG), ...TEXT_KEYS }));

    const r = await run(RESTORE, [file, "--into", "dst-ns", "--drop-corrupt", "--verify"], env(dst.base));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /1 key\(s\) will NOT be written/);
    // Absent, not ruined: the canvas client re-uploads on the next paste of that image,
    // which it would never do if the key existed.
    assert.equal(dst.store.has(KEY), false);
    assert.equal(dst.store.size, Object.keys(TEXT_KEYS).length);
  } finally { await dst.close(); }
});

test("a value in a shape the codec cannot read stops the run before the target is touched", async () => {
  const dst = await startFakeKvApi();
  try {
    const file = path.join(tmp(), "kv.json");
    writeFileSync(file, JSON.stringify({ "c:/proto/": { nope: "AAA=" } }));
    const r = await run(RESTORE, [file, "--into", "dst-ns"], env(dst.base));
    assert.equal(r.status, 1);
    assert.match(r.out, /unreadable backup value/);
    assert.equal(dst.store.size, 0);
  } finally { await dst.close(); }
});

test("--dry-run reports the checksum verdict and writes nothing", async () => {
  const dst = await startFakeKvApi();
  try {
    const file = path.join(tmp(), "kv.json");
    writeFileSync(file, JSON.stringify({ [KEY]: encodeKvValue(PNG), ...TEXT_KEYS }));
    const r = await run(RESTORE, [file, "--into", "dst-ns", "--dry-run"], env(dst.base));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /1 content-addressed key\(s\), 1 value\(s\) carried as base64, 0 failing/);
    assert.match(r.out, new RegExp(`would write {2}${KEY} {2}\\(bytes\\)`));
    assert.equal(dst.store.size, 0);
  } finally { await dst.close(); }
});

test("the live namespace is still refused without --force", async () => {
  // Unchanged behaviour, restated because the new guard runs near it: reordering the two
  // would put a checksum report in front of a refusal to touch live.
  const file = path.join(tmp(), "kv.json");
  writeFileSync(file, JSON.stringify({ statuses: "{}" }));
  const r = await run(RESTORE, [file, "--into", "live-ns"], env("http://127.0.0.1:1"));
  assert.equal(r.status, 1);
  assert.match(r.out, /LIVE namespace/);
});

test("an empty namespace is not exported as a backup", async () => {
  const src = await startFakeKvApi();
  try {
    const r = await run(EXPORT, ["--out", path.join(tmp(), "kv.json")], env(src.base, { AUGUR_KV_NS: "src-ns" }));
    assert.equal(r.status, 1);
    assert.match(r.out, /ZERO keys/);
  } finally { await src.close(); }
});
