// restore-drill.mjs — prove the offsite copy can be put back, on a throwaway namespace.
//
//   node ops/offsite/restore-drill.mjs
//   … --keep          leave the scratch namespace behind for inspection
//   … --ns <id>       reuse an existing scratch namespace instead of creating one
//
// ⛔ WHY THIS EXISTS AT ALL. On 28 Aug 2026 a migration destroyed a live hosted
// workspace's identity documents and there was nothing to restore from. The answer to
// that is not a backup job; it is a backup job somebody has watched put the data back.
// `D-2-hosted-namespace-backup` says so in one line — "a restore nobody has executed is
// not a rollback" — and this is that execution, as a command rather than as an afternoon.
//
// ── WHAT IT DOES, AND WHY IN THIS ORDER ────────────────────────────────────────────
//
//   1. create a scratch KV namespace. NOT the live one, and never `--force` onto it:
//      the drill must not be able to become the incident.
//   2. seed it with the seven documents the 28 Aug loss was made of —
//      publish:tokens, users:roster, users:roles, users:names, users:avatars,
//      users:spaces, spaces:icons — plus an avatar data URI and a real PNG under a
//      content-addressed `basset:` key, because a copy that reads values as text
//      destroys exactly those two and reports success.
//   3. take a REAL offsite copy of that namespace: same script, same locked bucket,
//      under its own throwaway tenant prefix. The drill restores from the object in
//      Scaleway, not from a file left over in /tmp — an untested download path is
//      still an untested restore.
//   4. ⚠️ MUTATE, THEN RESTORE. Three documents are DELETED and four are OVERWRITTEN
//      with a sentinel. This is the whole difference between a drill and a placebo:
//      if you back up and immediately restore, a restore that did nothing at all and
//      a restore that worked perfectly produce the same bytes, and both read green.
//      The sentinel has to disappear for the run to pass.
//   5. fetch the copy back down (sha256-checked against the index it was written with)
//      and replay it.
//   6. compare, and here is the part that is easy to get wrong:
//
// ⚠️ EVERY READ-BACK IS THE CLOUDFLARE KV REST API, NEVER THE WORKER — AND THAT ALONE IS
// NOT ENOUGH. A worker's `kv.get` carries a 60-second cache TTL (measured on this
// deployment: a value written straight into the namespace was invisible through the
// worker at t+20s and visible at t+40s), so verifying a restore through the worker can
// hand you the PRE-RESTORE bytes and call them a match — which, in a back-up-then-restore
// drill, is precisely the shape that reads green while proving nothing.
//
// The account API is the authority, so it is what this reads. But it is ALSO cached, for
// about the same 60 seconds, and the cache is filled by a READ — so the drill's own
// baseline read is what makes the following minute stale. There is no endpoint that is
// both immediate and authoritative. What makes the result trustworthy is therefore the
// SENTINEL (a stale read can only produce a false RED, never a false green) and waiting
// past the TTL. `restore-kv.mjs --verify` reads through the same account API.
//
//   7. delete the scratch namespace, unless --keep.
//
// Credentials: the same ones the backup uses — CLOUDFLARE_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID and BACKUP_S3_*. Nothing is minted here.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const KEEP = flag("--keep");

const ACC = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOK = process.env.CLOUDFLARE_API_TOKEN;
const LIVE_NS = process.env.AUGUR_KV_NS || "";
if (!ACC || !TOK) die("need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID");
for (const v of ["BACKUP_S3_KEY_ID", "BACKUP_S3_SECRET", "BACKUP_S3_BUCKET"]) {
  if (!process.env[v]) die(`need ${v} — the drill restores from the real bucket, not from a temp file`);
}

const log = (m) => console.error(`\x1b[36m[drill]\x1b[0m ${m}`);
const ok = (m) => console.error(`\x1b[32m[drill]\x1b[0m ${m}`);
const warn = (m) => console.error(`\x1b[33m[drill]\x1b[0m ${m}`);
function die(m) { console.error(`\x1b[31m[drill] ${m}\x1b[0m`); process.exit(1); }
// ⚠️ INSIDE THE try, FAILURE MUST THROW AND NOT EXIT. `process.exit` skips `finally`, and
// the finally block is what deletes the scratch namespace — so the first version of this
// script left one behind on every failed run, which is litter on the account the drill
// exists to protect.
function fail(m) { throw new Error(m); }

const API = "https://api.cloudflare.com/client/v4";
const H = { authorization: `Bearer ${TOK}` };
async function cf(method, url, { body = null, headers = {} } = {}) {
  const res = await fetch(`${API}${url}`, { method, headers: { ...H, ...headers }, body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  }
  return j.result;
}

/** THE AUTHORITY. Raw bytes of one key, straight from the account API — no worker, no cache. */
async function readKeyBytes(ns, key) {
  const res = await fetch(`${API}/accounts/${ACC}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`, { headers: H });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read ${key} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const sha = (b) => createHash("sha256").update(b).digest("hex");

/**
 * Read until the answer is the one being asserted, or give up and let the caller fail.
 *
 * ⚠️ THE ACCOUNT API IS THE AUTHORITY AND IT IS STILL CACHED. This was measured here, and
 * it is the correction to the obvious plan. The advice this drill was built on was "read
 * back through the Cloudflare KV REST API rather than through the worker, because the
 * worker's `kv.get` carries a 60-second cache TTL" — true about the worker, and NOT
 * enough: KV's read path caches at the edge for about 60 seconds for the REST API too,
 * and the cache is populated BY A READ. So the drill's own baseline read of each key is
 * what makes the next 60 seconds of reads stale. Measured: a `publish:tokens` overwrite
 * on a key read moments earlier was still invisible 30 seconds later; the same overwrite
 * on a cold key is visible at once.
 *
 * WHAT THAT MEANS FOR A RESTORE DRILL: there is no read path that is both immediate and
 * authoritative. The answer is not a better endpoint, it is a sentinel plus patience —
 * so this waits past the TTL by default rather than assuming an endpoint is honest.
 *
 * THIS IS ONLY EVER USED TO WAIT FOR SOMETHING TO BECOME TRUE, never to accept a
 * failure. And it matters which direction each wait runs in: waiting for the drill's own
 * DESTRUCTION to appear can only make the drill stricter, and waiting for the RESTORE to
 * appear cannot manufacture a pass, because a stale read after a restore returns the
 * sentinel or a 404 — both of which fail. The false green this whole drill is shaped
 * against is a read that returns the ORIGINAL bytes while the restore did nothing, and
 * the sentinel is what makes that impossible to spell.
 */
const KV_READ_TTL_MS = Number(process.env.DRILL_KV_WAIT_MS || 150000);
async function until(label, fn, timeoutMs = KV_READ_TTL_MS) {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const got = await fn();
    if (got.ok) return { ...got, waitedMs: Date.now() - started, attempts: attempt };
    if (Date.now() - started > timeoutMs) return { ...got, waitedMs: Date.now() - started, attempts: attempt, timedOut: true };
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ── 1. the scratch namespace ────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
let NS = opt("--ns");
let created = false;
if (!NS) {
  const title = `augur-restore-drill-${stamp}`;
  NS = (await cf("POST", `/accounts/${ACC}/storage/kv/namespaces`, {
    body: JSON.stringify({ title }), headers: { "content-type": "application/json" },
  })).id;
  created = true;
  log(`scratch namespace ${title} = ${NS}`);
}
if (NS === LIVE_NS) die("--ns is the LIVE namespace. The drill exists so that it never has to be run there.");

let failed = false;
const t0 = Date.now();
try {
  // ── 2. seed it with the documents 28 Aug lost ─────────────────────────────────────
  //
  // Shapes copied from what the engine actually writes (src/_worker.js), not invented:
  // a restore that round-trips a shape nothing produces has proved nothing about the
  // shape that matters. `publish:tokens` is taken from the LIVE namespace when one is
  // configured, because that is the document whose loss is the reason for this item —
  // and it holds token HASHES, never tokens.
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da63fcffff3f0305fe02fdfc4f6a2b0000000049454e44ae426082",
    "hex");
  const bassetKey = `basset:${sha(png)}`;
  const avatarUri = `data:image/png;base64,${png.toString("base64")}`;

  let livePublishTokens = null;
  if (LIVE_NS) {
    const raw = await readKeyBytes(LIVE_NS, "publish:tokens").catch(() => null);
    if (raw) { livePublishTokens = raw.toString("utf8"); log(`seeding publish:tokens from the LIVE document (${raw.length} bytes, hashes only)`); }
  }

  const seed = {
    "publish:tokens": livePublishTokens || JSON.stringify({
      [sha(Buffer.from("drill-token-a"))]: { space: "*", label: "ci", createdAt: "2026-08-01T00:00:00.000Z" },
      [sha(Buffer.from("drill-token-b"))]: { space: "fulla", label: "space-repo-ci", createdAt: "2026-08-02T00:00:00.000Z" },
    }),
    "users:roster": JSON.stringify({
      add: {
        "ada@example.test": { email: "ada@example.test", name: "Ada Lovelace", role: "admin", initials: "AL", color: "#4b6", addedAt: "2026-08-10T09:00:00.000Z", addedBy: "rob@example.test" },
        "grace@example.test": { email: "grace@example.test", name: "Grace Hopper", role: "editor", initials: "GH", color: "#b64", addedAt: "2026-08-11T09:00:00.000Z", addedBy: "ada@example.test" },
      },
      remove: ["gone@example.test"],
    }),
    "users:roles": JSON.stringify({ "ada@example.test": "admin", "grace@example.test": "editor" }),
    "users:names": JSON.stringify({ "ada@example.test": "Ada L.", "grace@example.test": "Grace H." }),
    "users:avatars": JSON.stringify({ "ada@example.test": { key: `avatar:ada@example.test`, updatedAt: "2026-08-12T09:00:00.000Z" } }),
    "users:spaces": JSON.stringify({ "ada@example.test": { fulla: "admin" }, "grace@example.test": { fulla: "editor" } }),
    "spaces:icons": JSON.stringify({ fulla: { key: "spaceicon:fulla:abc123", updatedAt: "2026-08-13T09:00:00.000Z" } }),
    // The two families every text-reading exporter has silently destroyed. Kept in the
    // drill so a regression there fails here rather than in a bucket nobody reads.
    "avatar:ada@example.test": avatarUri,
  };
  // THE SEVEN THE ITEM NAMES. Asserted as a list rather than assumed from the object
  // above, so deleting a line from the seed cannot quietly shrink what the drill covers.
  const REQUIRED = ["publish:tokens", "users:roster", "users:roles", "users:names",
                    "users:avatars", "users:spaces", "spaces:icons"];
  for (const k of REQUIRED) if (!(k in seed)) fail(`the seed is missing ${k}, which this drill exists to cover`);

  const bulk = [
    ...Object.entries(seed).map(([key, value]) => ({ key, value })),
    { key: bassetKey, value: png.toString("base64"), base64: true },
  ];
  await cf("PUT", `/accounts/${ACC}/storage/kv/namespaces/${NS}/bulk`, {
    body: JSON.stringify(bulk), headers: { "content-type": "application/json" },
  });
  log(`seeded ${bulk.length} keys (${REQUIRED.length} of them the families lost on 28 Aug)`);

  // What the truth is, before anything else happens. Every later comparison is against
  // THIS, read from the account API.
  const before = {};
  for (const { key } of bulk) {
    const b = await readKeyBytes(NS, key);
    if (!b) fail(`${key} did not survive the seed — the drill cannot start`);
    before[key] = b;
  }
  log(`baseline: ${Object.keys(before).length} keys read back from the account API`);

  // ── 3. a real offsite copy of the scratch namespace ───────────────────────────────
  const tenant = `_drill-${stamp}`;
  log(`taking a real offsite copy under tenants/${tenant}/ …`);
  execFileSync("node", [path.join(HERE, "offsite-backup.mjs"), "--slot", "nightly", "--retain", "1"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, AUGUR_KV_NS: NS, BACKUP_TENANT: tenant },
  });

  // ── 4. MUTATE. Three gone, four overwritten with a sentinel. ──────────────────────
  const SENTINEL = `{"__drill_sentinel__":"${randomUUID()}"}`;
  const destroyed = ["users:roster", "users:names", "spaces:icons"];
  const overwritten = ["publish:tokens", "users:roles", "users:avatars", "users:spaces"];
  for (const k of destroyed) {
    await cf("DELETE", `/accounts/${ACC}/storage/kv/namespaces/${NS}/values/${encodeURIComponent(k)}`);
  }
  await cf("PUT", `/accounts/${ACC}/storage/kv/namespaces/${NS}/bulk`, {
    body: JSON.stringify(overwritten.map((key) => ({ key, value: SENTINEL }))),
    headers: { "content-type": "application/json" },
  });
  // The mutation is CONFIRMED before the restore, so "the restore worked" can never be
  // a reading of "the mutation never landed". Waited for rather than asserted once —
  // see `until`: KV acknowledges a delete before every reader can see it.
  let waited = 0;
  for (const k of destroyed) {
    const r = await until(k, async () => ({ ok: (await readKeyBytes(NS, k)) === null }));
    if (r.timedOut) fail(`${k} is still present ${(r.waitedMs / 1000).toFixed(0)}s after being deleted — the drill's own destruction did not land`);
    if (r.waitedMs > 3000) log(`  ${k}: delete visible after ${(r.waitedMs / 1000).toFixed(1)}s (KV read cache)`);
    waited = Math.max(waited, r.waitedMs);
  }
  for (const k of overwritten) {
    const r = await until(k, async () => {
      const got = await readKeyBytes(NS, k);
      return { ok: !!got && got.toString("utf8") === SENTINEL };
    });
    if (r.timedOut) fail(`${k} does not hold the sentinel after ${(r.waitedMs / 1000).toFixed(0)}s — the drill's own overwrite did not land`);
    if (r.waitedMs > 3000) log(`  ${k}: sentinel visible after ${(r.waitedMs / 1000).toFixed(1)}s (KV read cache)`);
    waited = Math.max(waited, r.waitedMs);
  }
  warn(`destroyed ${destroyed.length} document(s), overwrote ${overwritten.length} with a sentinel — all confirmed via the account API (worst wait ${(waited / 1000).toFixed(1)}s)`);

  // ── 5. fetch the copy back from the bucket and replay it ──────────────────────────
  const work = mkdtempSync(path.join(tmpdir(), "augur-drill-"));
  const restoreStarted = Date.now();
  execFileSync("node", [path.join(HERE, "fetch-backup.mjs"), "--out", path.join(work, "recover"), "--tenant", tenant], {
    stdio: ["ignore", "inherit", "inherit"], env: process.env,
  });
  const kvFile = path.join(work, "recover", "kv.json");
  execFileSync("node", [path.join(HERE, "restore-kv.mjs"), kvFile, "--into", NS, "--force", "--verify"], {
    stdio: ["ignore", "inherit", "inherit"], env: process.env,
  });
  const restoreMs = Date.now() - restoreStarted;

  // ── 6. the verdict, read from the account API and from the downloaded copy ────────
  const copy = JSON.parse(readFileSync(kvFile, "utf8"));
  let bad = 0;
  for (const [key, want] of Object.entries(before)) {
    const r = await until(key, async () => {
      const got = await readKeyBytes(NS, key);
      return { ok: !!got && got.equals(want), got };
    });
    const got = r.got;
    if (!got) { console.error(`\x1b[31m  MISSING after restore  ${key}\x1b[0m`); bad++; continue; }
    if (got.toString("utf8") === SENTINEL) { console.error(`\x1b[31m  SENTINEL SURVIVED     ${key} — the restore did not write this document\x1b[0m`); bad++; continue; }
    if (!got.equals(want)) { console.error(`\x1b[31m  DIFFERS after restore  ${key} (${want.length} → ${got.length} bytes)\x1b[0m`); bad++; continue; }
    console.error(`  ✔ ${key.padEnd(26)} ${String(got.length).padStart(6)} bytes  sha256 ${sha(got).slice(0, 16)}${r.waitedMs > 3000 ? `  (visible after ${(r.waitedMs / 1000).toFixed(1)}s)` : ""}`);
  }
  // And the copy itself has to be the thing that was restored FROM, not a coincidence.
  for (const k of REQUIRED) {
    if (!(k in (copy.data || {}))) { console.error(`\x1b[31m  NOT IN THE COPY        ${k}\x1b[0m`); bad++; }
  }
  if (bad) fail(`${bad} check(s) failed — this restore is NOT sound.`);
  ok(`all ${Object.keys(before).length} documents byte-identical to the baseline, read from the Cloudflare account API`);
  ok(`no sentinel survived: every one of the ${overwritten.length} overwritten documents was genuinely rewritten`);
  ok(`RESTORE WALL CLOCK: ${(restoreMs / 1000).toFixed(1)}s (fetch from Scaleway + replay + read-back verify)`);
  ok(`whole drill: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  rmSync(work, { recursive: true, force: true });
} catch (e) {
  failed = true;
  console.error(`\x1b[31m[drill] ${e && e.message ? e.message : e}\x1b[0m`);
} finally {
  // ── 7. put the scratch namespace away ───────────────────────────────────────────
  if (created && !KEEP) {
    await cf("DELETE", `/accounts/${ACC}/storage/kv/namespaces/${NS}`).then(
      () => log(`scratch namespace ${NS} deleted`),
      (e) => warn(`could not delete the scratch namespace ${NS}: ${e.message} — delete it by hand`));
  } else if (KEEP) {
    warn(`--keep: scratch namespace ${NS} left behind. Delete it when you are done.`);
  }
  if (failed) process.exit(1);
  console.log(NS);
}
