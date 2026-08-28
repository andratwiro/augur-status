// restore-kv.mjs — replay a KV backup into a namespace.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
//     node scripts/restore-kv.mjs kv.json --into <namespace-id>
//
//   … --dry-run       say what would be written, write nothing
//   … --verify        after writing, read every key back and compare byte-for-byte
//   … --force         allow a namespace that already holds keys
//   … --drop-corrupt  write the rest of a copy whose content-addressed keys do not
//                     match their contents, leaving those keys ABSENT
//
// Reads every shape of backup: the engine's `GET /__admin/backup` document or
// `scripts/kv-export.mjs`'s (they are the same document), and also a bare
// {key: value} object, which is what the older `kv-backup.yml` branch holds. Values
// are strings, or {"b64": "…"} for the ones whose bytes are not UTF-8 text — see
// scripts/lib/kv-codec.mjs. Detection is per value, so a copy taken before the marker
// existed and one taken after are read by the same code.
//
// ⚠️ IT REFUSES A COPY WHOSE CONTENT-ADDRESSED KEYS DO NOT MATCH THEIR CONTENTS.
// Every export path used to read values as text, which destroyed every canvas board
// image in every copy taken before that was fixed — and a copy already taken cannot be
// repaired. What CAN be fixed is this end: `basset:<hash>` keys carry their own SHA-256
// prefix, so the check needs nothing to compare against, and the answer is not a warning.
// Writing the ruin back is strictly worse than leaving the key absent: a missing asset is
// a broken image, a corrupt one is a broken image that also lies about its hash and can
// never be replaced, because the canvas client skips the upload when the key exists.
//
// THE TARGET IS NEVER IMPLICIT. `--into` is required and is compared against the
// live namespace this instance is bound to; restoring over a live namespace needs
// `--force` and says so loudly. The drill this script exists for restores into a
// FRESH namespace, and a script that makes the safe thing the default is the only
// kind worth having on the day it matters.

import { readFileSync } from "node:fs";
import { decodeKvValue, isBinaryKvValue, contentAddressFailures } from "./lib/kv-codec.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
let FILE = null;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) { if (args[i] === "--into") i++; continue; }
  FILE = args[i];
  break;
}
const INTO = opt("--into");
const DRY = flag("--dry-run");
const VERIFY = flag("--verify");
const FORCE = flag("--force");
const DROP_CORRUPT = flag("--drop-corrupt");

const ACC = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOK = process.env.CLOUDFLARE_API_TOKEN;
const LIVE_NS = process.env.AUGUR_KV_NS || process.env.GV_KV_NS || "";

const log = (m) => console.error(`\x1b[36m[restore-kv]\x1b[0m ${m}`);
const die = (m) => { log(m); process.exit(1); };

if (!FILE) die("name the backup file: node scripts/restore-kv.mjs <kv.json> --into <namespace-id>");
if (!ACC || !TOK) die("need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID");
if (!INTO) die("name the target namespace: --into <namespace-id>  (never implicit — see the header)");
if (INTO === LIVE_NS && !FORCE) {
  die(`--into is this instance's LIVE namespace. A drill restores into a fresh one. ` +
      `If overwriting live is genuinely what you mean, add --force.`);
}

// The API root is overridable so this script can be driven end to end against a local
// stand-in. The parts worth proving — that a binary value goes up as `base64: true` and
// that the read-back compares BYTES — cannot be proven by reading the code, and proving
// them must not need a Cloudflare account or a network.
const API_ROOT = process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";
const API = `${API_ROOT}/accounts/${ACC}/storage/kv/namespaces/${INTO}`;
const H = { authorization: `Bearer ${TOK}` };

// ── read the backup, whichever shape it is ──────────────────────────────────
const raw = JSON.parse(readFileSync(FILE, "utf8"));
const envelope = raw && typeof raw === "object" && raw.data && typeof raw.data === "object";
const data = envelope ? raw.data : raw;
const expirations = (envelope && raw.expirations) || {};
if (!data || typeof data !== "object" || Array.isArray(data)) die(`${FILE} is not a KV backup — expected an object of key → value`);

// A copy that never finished is not a copy. The engine's stream tears down mid-JSON
// on a read failure, so a truncated one usually fails to parse at all — but an
// explicit `complete: false` is the case where it parsed and still must not be used.
if (envelope && raw.complete === false) die(`${FILE} says complete:false — this copy is short. Refusing.`);
let pairs = Object.entries(data);
if (!pairs.length) die(`${FILE} holds zero keys — refusing to "restore" nothing`);
log(`${FILE}: ${pairs.length} keys${envelope ? `, taken ${raw.at}` : ""}${raw.namespace ? `, from namespace ${raw.namespace}` : ""}`);
if (envelope && (raw.vanished || []).length) {
  log(`\x1b[33m${raw.vanished.length} key(s) were already gone when the copy was taken — they will not come back: ${raw.vanished.slice(0, 3).join(", ")}…\x1b[0m`);
}

// ── the value must be what its own key name says it is ──────────────────────
// The only integrity check available without a second copy to compare against, and it
// is a complete one for the keys that have it: `basset:<hash>` IS the SHA-256 prefix of
// the bytes. Run it before anything is written, and in --dry-run too, so the answer
// arrives before the decision rather than after the damage.
{
  const bad = contentAddressFailures(data);
  const binary = pairs.filter(([, v]) => isBinaryKvValue(v)).length;
  const addressed = pairs.filter(([k]) => k.startsWith("basset:")).length;
  log(`${addressed} content-addressed key(s), ${binary} value(s) carried as base64, ${bad.length} failing their own checksum`);
  if (bad.length) {
    for (const b of bad.slice(0, 10)) {
      log(`\x1b[31m  CORRUPT ${b.key}\x1b[0m`);
      log(`          key says sha256 starts ${b.expected}`);
      log(`          value is ${b.why ? b.why : `${b.bytes} bytes hashing to ${b.actual}`}`);
    }
    if (bad.length > 10) log(`\x1b[31m  … and ${bad.length - 10} more\x1b[0m`);
    if (!DROP_CORRUPT) {
      die(`\x1b[31m${bad.length} value(s) in ${FILE} are not the values their keys name.\x1b[0m\n` +
          `           This copy was taken by an exporter that read KV values as TEXT, which destroys\n` +
          `           every value that is not UTF-8 — canvas board images, in this namespace. The copy\n` +
          `           cannot be repaired; what must not happen is writing the ruin back, because a\n` +
          `           content-addressed key that EXISTS is never re-uploaded by the canvas client, so\n` +
          `           the image would be lost a second time by the restore.\n` +
          `           Restore the rest and leave those keys absent (a broken image, re-pastable):\n` +
          `             node scripts/restore-kv.mjs ${FILE} --into ${INTO} --drop-corrupt --verify`);
    }
    const drop = new Set(bad.map((b) => b.key));
    pairs = pairs.filter(([k]) => !drop.has(k));
    log(`\x1b[33m--drop-corrupt: ${drop.size} key(s) will NOT be written. They stay absent, which is ` +
        `re-pastable; writing them would not be.\x1b[0m`);
    if (!pairs.length) die("nothing left to restore once the corrupt keys are dropped");
  }
}

// A value the codec cannot read at all is not something to guess at. Fail here, before
// the target namespace has been touched, rather than part way through the write.
for (const [k, v] of pairs) {
  try { decodeKvValue(v); } catch (e) { die(`${FILE}: ${k}: ${e.message}`); }
}

// ── refuse to land on top of unrelated data ─────────────────────────────────
{
  const res = await fetch(`${API}/keys?limit=10`, { headers: H });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.success) die(`target namespace ${INTO} is not readable → ${res.status} ${JSON.stringify(j.errors || j).slice(0, 200)}`);
  const existing = (j.result || []).length;
  if (existing && !FORCE) {
    die(`target namespace ${INTO} already holds keys (${existing}+ listed). A fresh-namespace restore expects an empty one. Add --force to write anyway.`);
  }
  log(`target ${INTO}: ${existing ? `${existing}+ keys present (--force)` : "empty"}`);
}

if (DRY) {
  for (const [k, v] of pairs.slice(0, 20)) console.log(`would write  ${k}${isBinaryKvValue(v) ? "  (bytes)" : ""}`);
  if (pairs.length > 20) console.log(`… and ${pairs.length - 20} more`);
  console.log(`(dry run — ${pairs.length} keys, nothing written; the checksum check above already ran)`);
  process.exit(0);
}

// ── write ───────────────────────────────────────────────────────────────────
// The bulk endpoint takes 10k pairs / 100 MB per call and is an order of magnitude
// faster than key-at-a-time, which is what turns a restore from "leave it running"
// into "watch it finish". Expirations ride along per pair.
//
// A value that is not text is sent with `base64: true`, which is the endpoint's own way
// of saying "these are bytes, decode them before storing". A JSON string cannot carry
// them: that is the same mistake at the other end of the trip.
const started = Date.now();
const BATCH = 5000;
let written = 0;
for (let i = 0; i < pairs.length; i += BATCH) {
  const body = pairs.slice(i, i + BATCH).map(([key, value]) => ({
    key,
    ...(isBinaryKvValue(value)
      ? { value: decodeKvValue(value).toString("base64"), base64: true }
      : { value }),
    ...(expirations[key] ? { expiration: Number(expirations[key]) } : {}),
  }));
  // A TTL that has already passed is rejected by the API rather than ignored, and a
  // rate-limit key from last night is exactly that. Drop the stale ones: the key
  // being absent is what it would be a second after the restore anyway.
  const now = Math.floor(Date.now() / 1000) + 120;
  for (const p of body) if (p.expiration && p.expiration <= now) delete p.expiration;

  const res = await fetch(`${API}/bulk`, {
    method: "PUT",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.success) die(`bulk write at ${i} → ${res.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  written += body.length;
  log(`${written}/${pairs.length} keys written`);
}
const wroteIn = (Date.now() - started) / 1000;
log(`wrote ${written} keys in ${wroteIn.toFixed(1)}s`);

// ── verify ──────────────────────────────────────────────────────────────────
// KV is eventually consistent on reads from other locations, but a read-back through
// the same API right after a write is the check worth having: it catches a value the
// API accepted and stored differently (encoding, truncation), which is the failure
// that would otherwise be discovered by a user.
// The read-back is BYTES on both sides. `res.text()` here would have compared two values
// that had each been ruined the same way and reported them equal — the check agreeing
// with the bug is worse than no check.
//
// ⚠️ AND IT HAS TO OUTWAIT THE READ CACHE, OR IT FAILS A SOUND RESTORE. KV's read path
// caches for about 60 seconds and the cache is filled BY A READ — so on a namespace whose
// keys have been read recently, which is every `--force` restore over live data, an
// immediate read-back returns the PRE-RESTORE value. Measured while drilling this: three
// of nine keys came back as their pre-restore selves (two 404, one the value that had
// just been overwritten) on a restore that had in fact written all nine correctly, and
// the same nine compared equal a minute later.
//
// That is a FALSE RED, at 3am, on the one command whose whole job is telling an operator
// whether their data came back. So a mismatch is retried rather than believed, for
// `VERIFY_WINDOW_MS` — and a key that never converges is still a failure. The fresh-
// namespace case this command is normally used for has no cache entry to be stale and
// converges on the first read, so nothing gets slower for getting this right.
const VERIFY_WINDOW_MS = Number(process.env.RESTORE_VERIFY_WINDOW_MS || 150000);
if (VERIFY) {
  const vStart = Date.now();
  let bad = 0, checked = 0, waited = 0;
  const queue = [...pairs];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const [k, v] = queue.pop();
      const want = decodeKvValue(v);
      let last = "";
      for (const started = Date.now(); ;) {
        const res = await fetch(`${API}/values/${encodeURIComponent(k)}`, { headers: H });
        if (res.ok) {
          const got = Buffer.from(await res.arrayBuffer());
          if (got.equals(want)) {
            checked++;
            waited = Math.max(waited, Date.now() - started);
            break;
          }
          last = `differs (${want.length} → ${got.length} bytes)`;
        } else {
          last = `missing (${res.status})`;
        }
        if (Date.now() - started > VERIFY_WINDOW_MS) {
          bad++;
          log(`\x1b[31m${last} after restore, and still ${Math.round((Date.now() - started) / 1000)}s later: ${k}\x1b[0m`);
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }));
  log(`verified ${checked}/${pairs.length} keys in ${((Date.now() - vStart) / 1000).toFixed(1)}s` +
      (waited > 3000 ? ` (slowest key took ${(waited / 1000).toFixed(1)}s to stop reading stale)` : ""));
  if (bad) die(`${bad} key(s) did not survive the round trip — this restore is NOT sound.`);
  console.log(`${INTO}  ${written} keys restored and verified byte-for-byte`);
  process.exit(0);
}

console.log(`${INTO}  ${written} keys restored (run again with --verify to prove it)`);
