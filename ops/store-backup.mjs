// store-backup.mjs — nightly off-Cloudflare copy of everything an Augur instance
// serves, to a local directory, with a shared blob pool so history is nearly free.
//
//   AUGUR_ORIGIN=https://… AUGUR_TOKEN=… \
//     node ops/store-backup.mjs --dir /var/lib/augur-backups/<instance>/store
//
//   … --keep 14            dated snapshots to retain (default 14)
//   … --keep-monthly 12    snapshots taken on the 1st, retained separately (default 12)
//   … --check              read the manifests, download nothing, write nothing
//
// ── WHAT IT COPIES ──────────────────────────────────────────────────────────────
//
// Every published unit the build stamp names — each space, plus the `_engine`
// chrome pseudo-space — as manifests + content-addressed blobs. Most of it is
// reproducible (clone the space at its recorded sha and publish again), but a
// publish made from a DIRTY working tree serves bytes held in no repository at all,
// and those are gone with the bucket. R2 has no point-in-time restore.
//
// Deliberately runs against the site's own HTTP API with a publish token, not
// Cloudflare account credentials — the weakest credential that can do the work, and
// a restore then needs nothing but this directory and a token.
//
// ── LAYOUT, AND WHY IT IS NOT ONE DIRECTORY PER NIGHT ───────────────────────────
//
//   <dir>/blobs/<sha256>              one immutable pool, shared by every snapshot
//   <dir>/snapshots/<date>/manifests/ that night's manifests
//   <dir>/snapshots/<date>/export.json
//   <dir>/snapshots/<date>/blobs -> ../../../blobs   (so each snapshot IS a restore dir)
//   <dir>/monthly/<date>              hard-linked copy of a 1st-of-month snapshot
//   <dir>/latest -> snapshots/<date>
//
// Blobs are named by their own hash, so they are never rewritten and two snapshots
// that share content share bytes. The instance's own store-backup.yml uploads a
// FULL ~102 MB artifact per run into GitHub's org-wide storage pool, which is why it
// could only afford weekly + monthly. Here the second night costs the delta, so the
// cadence can be nightly and the retention can be a fortnight.
//
// Each snapshot directory is a valid `augur restore <dir>` target on its own — the
// blobs symlink is what makes that true without copying 102 MB fourteen times.
//
// ── REFUSING A SHORT COPY ───────────────────────────────────────────────────────
//
// A backup that quietly omits a space is the one you discover is short on the day
// you need it. A 403 on a manifest means the token is space-scoped and cannot read
// that unit; that is recorded in `skipped` and, unless the id is named in
// AUGUR_EXPECT_SKIPPED, it fails the run. Any blob that will not download fails the
// run outright — a partial copy that reports success is worse than no copy.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────
//
// An INTERIM, same as ops/kv-backup.mjs. The real answer is plan item D-2: a
// versioned, object-locked, off-site destination where last night's copy cannot be
// deleted tonight by anything holding today's credentials. This protects against
// Cloudflare losing the bucket. It does not protect against this machine.

import { mkdir, writeFile, readFile, readdir, rm, symlink, unlink, link, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const DIR = opt("--dir");
const KEEP = Number(opt("--keep", "14"));
const KEEP_MONTHLY = Number(opt("--keep-monthly", "12"));
const CHECK = flag("--check");

const ORIGIN = (process.env.AUGUR_ORIGIN || "").replace(/\/+$/, "");
const TOKEN = process.env.AUGUR_TOKEN || "";
const LABEL = process.env.AUGUR_INSTANCE || "instance";
const EXPECT_SKIPPED = new Set((process.env.AUGUR_EXPECT_SKIPPED || "").split(",").map((s) => s.trim()).filter(Boolean));

const log = (m) => console.error(`\x1b[36m[store-backup]\x1b[0m ${m}`);
const die = (m) => { log(`\x1b[31m${m}\x1b[0m`); process.exit(1); };

if (!ORIGIN) die("need AUGUR_ORIGIN — the instance's site origin");
if (!TOKEN) die("need AUGUR_TOKEN — a publish token that can read the manifests");
if (!DIR && !CHECK) die("name a destination: --dir <dir>");

// Published content is not a credential the way a KV export is, but a copy of an
// unannounced client's whole site still does not belong in a repo.
if (DIR) {
  let p = path.resolve(DIR);
  for (;;) {
    if (existsSync(path.join(p, ".git"))) die(`${DIR} is inside a git tree (${p}) — point --dir outside git.`);
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
}

const started = Date.now();
const auth = { Authorization: `Bearer ${TOKEN}` };

async function api(pathPart, init = {}) {
  const url = `${ORIGIN}/__publish/${pathPart}`;
  const r = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  if (!r.ok && r.status !== 204) {
    const body = await r.text().catch(() => "");
    throw new Error(`GET ${url} → ${r.status} ${body.slice(0, 200)}`);
  }
  return r;
}

// The public build stamp names every publishable unit. Cache-busted: the CDN serves
// it stale for a minute or two after a publish, and a stale read is how you back up
// the state before the thing you were trying to capture.
const stampRes = await fetch(`${ORIGIN}/_build.json?t=${Date.now()}`, { headers: { Accept: "application/json" } });
if (!stampRes.ok) die(`GET ${ORIGIN}/_build.json → ${stampRes.status}`);
const stamp = await stampRes.json();
const ids = [...Object.keys(stamp.spaces || {}).sort(), "_engine"];
log(`${ORIGIN}: ${ids.length} unit(s) — ${ids.join(", ")}`);

// hash → { s: byte size, via: a unit id whose manifest references it }. Blobs are
// global to the store but the API path is scoped, and a space-scoped token is only
// accepted on its own space — so each hash remembers a route it can be fetched by.
const wanted = new Map();
const spaces = [];
const skipped = [];
const manifests = {};

for (const id of ids) {
  let live;
  try {
    live = await (await api(`${id}/manifest`)).json();
  } catch (e) {
    if (/→ 403/.test(e.message)) {
      const expected = EXPECT_SKIPPED.has(id);
      log(`${expected ? "\x1b[33m⚠" : "\x1b[31m✗"} ${id}: this token cannot read it — NOT IN THIS COPY${expected ? " (expected)" : ""}\x1b[0m`);
      skipped.push({ id, reason: "forbidden", expected });
      continue;
    }
    die(`${id}: could not read its manifest — ${e.message}`);
  }
  manifests[id] = live;
  for (const f of Object.values(live.files || {})) if (f && f.h && !wanted.has(f.h)) wanted.set(f.h, { s: f.s || 0, via: id });
  spaces.push({ id, version: live.version || 0, publishedAt: live.publishedAt || null, source: live.source || null });
  log(`${id}: v${live.version || 0}, ${Object.keys(live.files || {}).length} files${live.source && live.source.dirty ? " \x1b[33m[dirty — these bytes exist in NO repository]\x1b[0m" : ""}`);
}

const unexpected = skipped.filter((s) => !s.expected);
if (unexpected.length) {
  die(`${unexpected.length} unit(s) could not be read (${unexpected.map((s) => s.id).join(", ")}) — this would be a ` +
      `copy that claims to be complete and is not. Widen the token's scope, or name them in ` +
      `AUGUR_EXPECT_SKIPPED if their absence is deliberate and understood.`);
}
if (!spaces.length) die("read zero manifests — refusing to write an empty copy");

if (CHECK) {
  const total = [...wanted.values()].reduce((n, v) => n + v.s, 0);
  log(`--check: ${spaces.length} unit(s), ${wanted.size} blobs (${(total / 1e6).toFixed(1)} MB). Nothing written.`);
  console.log(JSON.stringify({ units: spaces.map((s) => `${s.id} v${s.version}`), blobs: wanted.size, bytes: total, skipped }, null, 2));
  process.exit(0);
}

// ── download into the shared pool ───────────────────────────────────────────────
const POOL = path.join(DIR, "blobs");
await mkdir(POOL, { recursive: true, mode: 0o700 });
const have = new Set(await readdir(POOL).catch(() => []));
if (have.size) log(`${have.size} blobs already in the pool — downloading only what is new`);

const todo = [...wanted.keys()].filter((h) => !have.has(h));
const newBytes = todo.reduce((n, h) => n + wanted.get(h).s, 0);
log(`${wanted.size} blobs referenced, ${todo.length} to fetch (${(newBytes / 1e6).toFixed(1)} MB)`);

let done = 0, failed = 0;
const queue = [...todo];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const h = queue.pop();
    for (let attempt = 0; ; attempt++) {
      try {
        const buf = Buffer.from(await (await api(`${wanted.get(h).via}/blob/${h}`)).arrayBuffer());
        await writeFile(path.join(POOL, h), buf, { mode: 0o600 });
        done++;
        if (done % 200 === 0) log(`${done}/${todo.length} blobs…`);
        break;
      } catch (e) {
        if (attempt >= 2) { failed++; log(`blob ${h.slice(0, 12)} failed: ${e.message}`); break; }
      }
    }
  }
}));
if (failed) die(`${failed} blob(s) failed — this copy is INCOMPLETE, do not trust it for restore.`);

// ── the snapshot ────────────────────────────────────────────────────────────────
const at = new Date().toISOString();
const today = at.slice(0, 10);
const snapDir = path.join(DIR, "snapshots", today);
await mkdir(path.join(snapDir, "manifests"), { recursive: true, mode: 0o700 });
for (const [id, m] of Object.entries(manifests)) {
  await writeFile(path.join(snapDir, "manifests", `${id}.json`), JSON.stringify(m), { mode: 0o600 });
}
// Makes the snapshot a self-contained `augur restore <dir>` target without copying
// the pool. Relative, so the whole tree can be moved or rsynced somewhere else.
try { await unlink(path.join(snapDir, "blobs")); } catch (e) {}
await symlink(path.join("..", "..", "blobs"), path.join(snapDir, "blobs"));

// format 1, field for field what `augur export` writes — so `augur restore` reads
// this with no special case, and so does anyone who knows that format.
await writeFile(path.join(snapDir, "export.json"), JSON.stringify({
  format: 1,
  origin: ORIGIN,
  exportedAt: at,
  history: false,
  spaces,
  skipped,
  blobs: wanted.size,
  instance: LABEL,
  takenBy: "augur-status ops/store-backup.mjs (local; GitHub Actions unavailable)",
}, null, 2), { mode: 0o600 });

try { await unlink(path.join(DIR, "latest")); } catch (e) {}
await symlink(path.join("snapshots", today), path.join(DIR, "latest"));

// A 1st-of-month snapshot is hard-linked into monthly/ (same inodes, no extra
// bytes) so the daily prune cannot take the old copy. Anything that corrupts the
// store on a Tuesday is in every copy taken after it; a fortnight of dailies
// protects you from accidents and not from something you notice late.
if (today.endsWith("-01")) {
  const mDir = path.join(DIR, "monthly", today);
  await mkdir(path.join(mDir, "manifests"), { recursive: true, mode: 0o700 });
  for (const f of await readdir(path.join(snapDir, "manifests"))) {
    try { await link(path.join(snapDir, "manifests", f), path.join(mDir, "manifests", f)); }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  try { await link(path.join(snapDir, "export.json"), path.join(mDir, "export.json")); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
  try { await unlink(path.join(mDir, "blobs")); } catch (e) {}
  await symlink(path.join("..", "..", "blobs"), path.join(mDir, "blobs"));
  log(`monthly slot: ${mDir}`);
}

// ── rotate, then garbage-collect the pool ───────────────────────────────────────
async function pruneSnapshots(dir, keep) {
  const kept = (await readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort();
  for (const f of kept.slice(0, Math.max(0, kept.length - keep))) {
    await rm(path.join(dir, f), { recursive: true, force: true });
    log(`pruned snapshot ${path.join(dir, f)}`);
  }
  return Math.min(kept.length, keep);
}
const dailies = await pruneSnapshots(path.join(DIR, "snapshots"), KEEP);
const monthlies = await pruneSnapshots(path.join(DIR, "monthly"), KEEP_MONTHLY);

// The pool is only safe to sweep AFTER the prune, and only against every surviving
// manifest — a blob referenced by a two-week-old snapshot is still live data.
const referenced = new Set();
for (const base of [path.join(DIR, "snapshots"), path.join(DIR, "monthly")]) {
  for (const snap of await readdir(base).catch(() => [])) {
    const mdir = path.join(base, snap, "manifests");
    for (const f of await readdir(mdir).catch(() => [])) {
      const m = JSON.parse(await readFile(path.join(mdir, f), "utf8"));
      for (const v of Object.values(m.files || {})) if (v && v.h) referenced.add(v.h);
    }
  }
}
let swept = 0, sweptBytes = 0;
for (const h of await readdir(POOL)) {
  if (referenced.has(h)) continue;
  sweptBytes += (await stat(path.join(POOL, h))).size;
  await rm(path.join(POOL, h));
  swept++;
}
if (swept) log(`swept ${swept} unreferenced blob(s), ${(sweptBytes / 1e6).toFixed(1)} MB`);

// ── dead-man ────────────────────────────────────────────────────────────────────
const poolFiles = await readdir(POOL);
let poolBytes = 0;
for (const h of poolFiles) poolBytes += (await stat(path.join(POOL, h))).size;

await writeFile(path.join(DIR, "status.json"), JSON.stringify({
  job: "store-backup",
  instance: LABEL,
  at,
  ok: true,
  origin: ORIGIN,
  units: spaces.map((s) => ({ id: s.id, version: s.version, dirty: !!(s.source && s.source.dirty) })),
  skipped,
  blobsReferenced: wanted.size,
  blobsFetched: done,
  poolFiles: poolFiles.length,
  poolBytes,
  snapshot: snapDir,
  retained: { daily: dailies, monthly: monthlies },
  tookMs: Date.now() - started,
}, null, 2) + "\n", { mode: 0o600 });

log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s — snapshot ${today}, pool ${poolFiles.length} blobs / ${(poolBytes / 1e6).toFixed(1)} MB, ${dailies} daily + ${monthlies} monthly retained`);
console.log(snapDir);
