// kv-codec — how a KV value crosses into a JSON backup, and how a restore reads one back.
//
// This is the Node twin of the engine's `src/kv-codec.mjs`, and it speaks the SAME
// format. It is a copy rather than an import on purpose: `restore-kv.mjs` is the script
// you run on the worst day, and making it depend on the engine submodule being checked
// out and current is a dependency it should not have. The FORMAT is the contract, not the
// code — the engine's test/kv-codec.test.mjs pins it.
//
// THE BUG IT CLOSES. Every export path read a value as TEXT — `res.text()` here,
// `kv.get(name, "text")` in the worker, `jq --rawfile` in the workflow. KV values are
// BYTES, and the canvas stores pasted board images raw under `basset:<sha256-prefix>`.
// A JPEG is not valid UTF-8, so every invalid sequence became U+FFFD on the way in and no
// re-encoding ever brought it back. Measured on this instance: 75,963 bytes live, 137,439
// bytes restored, 31,408 of 72,232 characters replaced, and the value no longer matching
// the checksum in its own key name. That is worse than a short backup, twice over: the
// copy is confidently WRONG rather than visibly missing, and restoring it writes the ruin
// under the content-addressed key, after which the canvas client skips re-uploading the
// real image because the key exists.
//
// THE FORMAT (`format: 2`). A value in `data` is EITHER:
//
//   a JSON string  — the value's bytes, which are valid UTF-8 text. Unchanged from
//                    format 1, so every value an older copy holds still reads.
//   {"b64": "…"}   — the value's bytes, base64. Written whenever the bytes are not
//                    valid UTF-8, i.e. whenever a string could not carry them.
//
// Detection is per value, so a reader needs no version negotiation: a copy taken before
// this existed and one taken after are read by the same code. The marker is an object
// because `data` values have always been strings, so it can collide with nothing.

import { createHash } from "node:crypto";

export const KV_BACKUP_FORMAT = 2;

const B64_FIELD = "b64";

// The one content-addressed key scheme in this namespace: the canvas board assets the
// worker stores under the first 40 hex characters of the SHA-256 of the image bytes
// (ASSET_PREFIX in the engine's src/_worker.js). The key IS the checksum, which is what
// lets a restore prove a value intact with nothing to compare it against — including a
// value from a copy taken before any of this existed.
const CONTENT_ADDRESSED = /^basset:([0-9a-f]{40})$/;

/** The bytes as JSON: a string when they are text, the base64 marker when they are not. */
export function encodeKvValue(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  try {
    // fatal → throws rather than substituting U+FFFD. ignoreBOM → a leading U+FEFF is
    // returned rather than eaten, so decode/encode is byte-exact.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch (e) {
    return { [B64_FIELD]: buf.toString("base64") };
  }
}

/** True when this JSON value is the base64 marker rather than a plain text value. */
export function isBinaryKvValue(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof v[B64_FIELD] === "string";
}

/**
 * The bytes a backup value stands for, as a Buffer. Throws on anything that is neither a
 * string nor the marker — a restore must STOP on a value it does not understand rather
 * than write its best guess, because writing a guess under a key is the whole bug.
 */
export function decodeKvValue(v) {
  if (typeof v === "string") return Buffer.from(v, "utf8");
  if (isBinaryKvValue(v)) return Buffer.from(v[B64_FIELD], "base64");
  throw new Error(`unreadable backup value: expected a string or {"${B64_FIELD}": "…"}, got ${Array.isArray(v) ? "an array" : v === null ? "null" : typeof v}`);
}

/** The hash a content-addressed key promises, or null if the key promises nothing. */
export function contentAddressOf(key) {
  const m = CONTENT_ADDRESSED.exec(String(key || ""));
  return m ? m[1] : null;
}

/**
 * Does this value match the checksum its own key name carries?
 *   true  — it does
 *   false — it does NOT: what is under this key is not what was stored there
 *   null  — the key is not content-addressed, so there is nothing to check
 */
export function contentAddressMatches(key, value) {
  const want = contentAddressOf(key);
  if (!want) return null;
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash("sha256").update(buf).digest("hex").slice(0, want.length) === want;
}

/**
 * Every key in a backup whose value is not the value its key name says it is.
 * Returns [{key, expected, actual, bytes}]. A value the codec cannot even read is
 * reported the same way, with `actual: null` — unreadable and wrong are the same verdict
 * as far as writing it is concerned.
 */
export function contentAddressFailures(data) {
  const bad = [];
  for (const [key, v] of Object.entries(data)) {
    const want = contentAddressOf(key);
    if (!want) continue;
    let buf = null;
    try { buf = decodeKvValue(v); } catch (e) {
      bad.push({ key, expected: want, actual: null, bytes: 0, why: e.message });
      continue;
    }
    const got = createHash("sha256").update(buf).digest("hex").slice(0, want.length);
    if (got !== want) bad.push({ key, expected: want, actual: got, bytes: buf.length });
  }
  return bad;
}
