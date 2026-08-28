// offsite-backup.mjs — one nightly copy of everything, somewhere Cloudflare cannot
// reach and this credential cannot delete.
//
//   node scripts/offsite-backup.mjs --slot nightly
//   node scripts/offsite-backup.mjs --check        preflight only, upload nothing
//   node scripts/offsite-backup.mjs --dry-run      build the bundle, upload nothing
//
// ─ Why this replaced the two jobs it supersedes ────────────────────────────────
// `store-backup.yml` put the bundle store in a GitHub Actions artifact.
// `kv-backup.yml` put the KV namespace on a branch of this repo. Both are real
// backups of the right things, and both live inside the blast radius of the same
// credential that could destroy the primary: anyone who can push here can delete
// them. That is accident cover, not attack cover, and ransomware is the threat
// model. A backup that lives where the primary lives is not a backup.
//
// ─ What a night's copy contains ────────────────────────────────────────────────
//   store.tar.gz    `augur export --full` — every space's live manifest + content
//                   blobs (the only copy of a publish made from a dirty working
//                   tree), PLUS `state.json` and `assets/`: the roster overlay,
//                   invites, publish tokens, statuses, card names, comment threads,
//                   boards, pins and the images pasted onto a canvas.
//                   ⚠️ `--full` IS THE DEFAULT HERE AND IT IS NOT THE DEFAULT IN THE
//                   ENGINE. Without it the copy is published content and nothing
//                   else, which is what a hosted workspace's whole backup was on
//                   28 Aug 2026 — see D-2-hosted-namespace-backup. `--no-full`
//                   turns it off and says why in the index.
//   kv.json.gz      the whole KV namespace: password hashes and reset tombstones,
//                   invites, publish tokens, the roster overlay, comment threads,
//                   statuses, pins, renames, canvases, avatars.
//                   ⚠️ ON THE SHARED HOSTED WORKER THIS IS ONE NAMESPACE FOR EVERY
//                   WORKSPACE, so it is a copy of the deployment, not of a tenant.
//                   The per-workspace copy is the `--full` store half above. Both
//                   are taken because they cover each other: the workspace object
//                   is not in KV, and KV holds families the workspace object has no
//                   table for (`spaces:icons`).
//   roster.tar.gz   identity.json + deploy.config.json — who exists and how the
//                   instance is wired. Reproducible from this repo, and included
//                   anyway: on the worst day you want one place to look, not two.
//                   Skipped, with a line saying so, when the shell has neither.
//   backup.json     the index — sizes, sha256 of each part, key and blob counts,
//                   the state family and asset counts, and the lock evidence from
//                   this run.
//
// ─ Two slots, on purpose — one recent copy and one old one ─────────────────────
//   nightly   every night, locked 10 days, live state    → always a copy under a day old
//   monthly   the 1st,     locked 40 days, + every version → always a copy about a month old
//
// The old slot is the one that matters against a quiet compromise. Anything that
// corrupts the data on a Tuesday is in every copy taken after it, so a rolling ten
// days protects against accidents and not against an attack you notice late. A
// month-old copy does.
//
// Only the monthly copy carries the store's version history, because it costs 38×
// (measured on Delta: 3.3 MB / 3.4s live-only against 126 MB / 117s for 324 retained
// versions). The nightly chain is what gives you rollback targets day by day; the
// monthly copy is what reaches back further than the chain does.
//
// ─ The lock is proven, not assumed ─────────────────────────────────────────────
// Believing a bucket is WORM when it is not is worse than knowing it is not, so the
// job refuses to run until it has watched the bucket refuse a deletion:
//
//   1. the bucket reports Object Lock enabled AND versioning enabled, or we stop;
//   2. a throwaway canary object is written with this run's lock settings, and a
//      permanent (version-addressed) delete of it is attempted. Denied → upload.
//      Allowed → nothing is uploaded and the job fails, having destroyed only the
//      canary. This runs BEFORE the real copy for exactly that reason;
//   3. after upload, the same permanent delete is attempted against the PREVIOUS
//      run's index object. That is the assertion that matters — not "new writes can
//      be locked" but "last night's copy cannot be taken away from me tonight".
//
// An unversioned DELETE is not a test of anything: it writes a delete marker and
// destroys nothing. Only the version-addressed delete is refused by Object Lock.
//
// ─ Credentials ─────────────────────────────────────────────────────────────────
//   BACKUP_S3_KEY_ID / BACKUP_S3_SECRET / BACKUP_S3_BUCKET   (or B2_KEY_ID /
//   B2_APPLICATION_KEY / B2_BUCKET, which is what the local env file calls them)
//   BACKUP_S3_ENDPOINT   optional — discovered from Backblaze when it is absent
//   AUGUR_TOKEN          star-scoped publish token (a space-scoped one silently
//                        misses `_engine`, and `--full` is refused outright; this
//                        job fails rather than accept either)
//   AUGUR_ORIGIN         the site
//   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / AUGUR_KV_NS   for the KV half
//
// ─ Where it finds the instance ─────────────────────────────────────────────────
// Dropped into a deploy shell's `scripts/` this needs nothing: the shell root is the
// parent directory, the engine is its `engine/` submodule, and `deploy.config.json`
// names the tenant and the origin. It also runs from anywhere else, which is the
// case that matters for a shell with no git remote and no CI:
//
//   AUGUR_SHELL_ROOT   where deploy.config.json / identity.json live (default: ..)
//   AUGUR_ENGINE_DIR   an engine checkout, for scripts/export.mjs
//                      (default: $AUGUR_SHELL_ROOT/engine)
//   BACKUP_TENANT      the key this copy is filed under. On the hosted worker that
//                      is the WORKSPACE, not the deployment — one prefix per
//                      workspace is what makes a per-workspace restore possible.
//
// Neither `deploy.config.json` nor `identity.json` has to exist. What must exist is
// a tenant and an origin, from the config or from the environment; the script says
// which one it could not find rather than guessing.
//
// The S3 credential should be write-only where the provider allows it (B2:
// listBuckets, listFiles, readFiles, writeFiles — and NOT deleteFiles). Object Lock
// makes deletion impossible either way; a key that cannot even ask is one less thing
// to reason about.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3, discoverB2Endpoint } from "./lib/s3.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The shell this copy is of. `..` is the deploy-shell layout (scripts/ inside the
// shell); AUGUR_SHELL_ROOT is every other layout, including "there is no shell here
// at all, the config is in the environment".
const ROOT = path.resolve(process.env.AUGUR_SHELL_ROOT || path.join(HERE, ".."));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const CHECK = flag("--check");
const DRY = flag("--dry-run");
const KEEP = opt("--out");
const SLOT = opt("--slot") || (new Date().getUTCDate() === 1 ? "monthly" : "nightly");
const RETAIN_DAYS = Number(opt("--retain") || (SLOT === "monthly" ? 40 : 10));
const LOCK_MODE = (process.env.BACKUP_LOCK_MODE || "COMPLIANCE").toUpperCase();
// Every retained version's manifest and blobs, not just what is live now. Measured on
// Delta: live state alone is 3.3 MB / 79 blobs / 3.4s; the full history is 126 MB /
// 1043 blobs / 117s — 38× for 324 old versions. So the nightly slot carries live state
// and the monthly slot carries history. The nightly chain already gives ten days of
// daily rollback targets, which is the granularity that matters when you notice a bad
// publish; the monthly copy is what reaches further back than the chain does.
const HISTORY = flag("--history") || (SLOT === "monthly" && !flag("--no-history"));
// ⚠️ ON BY DEFAULT, WHICH IS THE OPPOSITE OF THE ENGINE'S DEFAULT, AND DELIBERATE.
// `augur export` without `--full` copies published content and nothing else — not the
// roster, not the invites, not the publish tokens, not a comment, not a board. That was
// the entire backup of a live hosted workspace on 28 Aug 2026, and the publish token that
// went with it existed nowhere else. A job whose name is "backup" must not have to be
// asked for the half that cannot be rebuilt. `--no-full` is available and is recorded in
// the index, so a content-only copy can never be mistaken for a whole one.
const FULL = !flag("--no-full");

const log = (m) => console.error(`\x1b[36m[offsite]\x1b[0m ${m}`);
const ok = (m) => console.error(`\x1b[32m[offsite]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[offsite] ${m}\x1b[0m`); process.exit(1); };

if (!["nightly", "monthly"].includes(SLOT)) die(`--slot must be nightly or monthly, got ${SLOT}`);
if (!["COMPLIANCE", "GOVERNANCE"].includes(LOCK_MODE)) die(`BACKUP_LOCK_MODE must be COMPLIANCE or GOVERNANCE`);

// ── configuration ─────────────────────────────────────────────────────────────
// FILL_ME is the placeholder the credentials file uses for "not provided yet".
// Naming the variable beats a confusing 401 twenty lines later.
const val = (...names) => {
  for (const n of names) {
    const v = (process.env[n] || "").trim();
    if (v && v !== "FILL_ME") return v;
  }
  return "";
};
const KEY_ID = val("BACKUP_S3_KEY_ID", "B2_KEY_ID");
const SECRET = val("BACKUP_S3_SECRET", "B2_APPLICATION_KEY");
const BUCKET = val("BACKUP_S3_BUCKET", "B2_BUCKET");
let ENDPOINT = val("BACKUP_S3_ENDPOINT");

const missing = [];
if (!KEY_ID) missing.push("BACKUP_S3_KEY_ID (or B2_KEY_ID)");
if (!SECRET) missing.push("BACKUP_S3_SECRET (or B2_APPLICATION_KEY)");
if (!BUCKET) missing.push("BACKUP_S3_BUCKET (or B2_BUCKET)");
if (missing.length) {
  die(`no off-Cloudflare destination is configured — ${missing.join(", ")} still unset.\n` +
      `  Until this is set there is NO backup outside Cloudflare and GitHub. See docs/restore-runbook.md.`);
}

// A shell may not be here at all, and a hosted shell that IS here has `spaces: []` —
// its workspaces are rows in Durable Objects, not entries in a config file. So the
// config is read when it exists and is never required to exist.
const CONFIG_PATH = path.join(ROOT, "deploy.config.json");
let cfg = {};
if (existsSync(CONFIG_PATH)) {
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) { die(`${CONFIG_PATH} is not readable JSON: ${e.message}`); }
}
const TENANT = val("BACKUP_TENANT") || cfg.spaces?.[0]?.id || "";
const ORIGIN = val("AUGUR_ORIGIN") || cfg.siteOrigin || "";
// ⚠️ NO "default" FALLBACK FOR THE TENANT. It used to be there, and on a deployment
// serving many workspaces it is the worst possible default: every workspace's copy
// files itself under one prefix, each night's run overwrites the last one's meaning,
// and the prior-copy delete probe at the end asserts the lock over somebody else's
// data. A prefix is an identity. Name it or stop.
if (!TENANT) die("no BACKUP_TENANT and no space in deploy.config.json — name the workspace this copy is OF.\n" +
                 "  On the shared hosted worker that is the workspace (the first label of its hostname), never the deployment.");
if (!ORIGIN) die("no AUGUR_ORIGIN and no siteOrigin in deploy.config.json");

if (!ENDPOINT) {
  log("no BACKUP_S3_ENDPOINT — asking Backblaze which region this key lives in");
  ENDPOINT = await discoverB2Endpoint(KEY_ID, SECRET).catch((e) =>
    die(`${e.message}\n  Set BACKUP_S3_ENDPOINT explicitly if this is not a Backblaze bucket.`));
}
const s3 = new S3({
  endpoint: ENDPOINT, bucket: BUCKET, keyId: KEY_ID, secret: SECRET,
  region: val("BACKUP_S3_REGION") || undefined,
  pathStyle: val("BACKUP_S3_PATH_STYLE") === "1",
});
log(`tenant ${TENANT} · slot ${SLOT}${FULL ? " · FULL (content + workspace state)" : " \x1b[33m· CONTENT ONLY (--no-full)\x1b[0m"}${HISTORY ? " · +version history" : ""} · ${LOCK_MODE} lock for ${RETAIN_DAYS} days · ${s3.host} (${s3.region})`);

const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\.\d{3}Z$/, "Z");
const day = stamp.slice(0, 10);
const PREFIX = `tenants/${TENANT}/${SLOT}/${day}`;
const retainUntil = new Date(Date.now() + RETAIN_DAYS * 864e5).toISOString().replace(/\.\d{3}Z$/, "Z");
const lockOpts = { lockMode: LOCK_MODE, retainUntil };

// ── 1. the bucket must SAY it is WORM ─────────────────────────────────────────
const lock = await s3.objectLock().catch((e) => die(`could not read the bucket's Object Lock configuration: ${e.message}`));
const versioning = await s3.versioning().catch((e) => die(`could not read the bucket's versioning configuration: ${e.message}`));
log(`bucket reports: object-lock ${lock.enabled ? "ENABLED" : `not enabled (${lock.why || "no configuration"})`} · versioning ${versioning}`);
if (!lock.enabled) {
  die(`bucket ${BUCKET} does not have Object Lock enabled. An unlocked bucket is not WORM — a\n` +
      `  compromised key deletes the backups as easily as the primary. Object Lock cannot be\n` +
      `  turned on after the fact on most providers (Backblaze included): make a NEW bucket with\n` +
      `  "Object Lock" on at creation, and point BACKUP_S3_BUCKET at it.`);
}
if (versioning !== "Enabled") {
  die(`bucket ${BUCKET} does not have versioning enabled. Object Lock without versioning protects\n` +
      `  nothing: an overwrite would replace the only copy.`);
}

// ── 2. watch it refuse a deletion, before trusting it with anything ───────────
{
  const key = `tenants/${TENANT}/_lockcheck/${stamp}.txt`;
  const body = Buffer.from(`lock probe ${stamp} ${TENANT} ${SLOT}\n`);
  const { versionId } = await s3.putObject(key, body, { contentType: "text/plain", ...lockOpts });
  if (!versionId) die("the bucket accepted an object but returned no version id — versioning is not really on.");
  const ret = await s3.objectRetention(key, versionId);
  log(`canary ${key} → version ${versionId.slice(0, 12)}…, retention ${ret ? `${ret.mode} until ${ret.retainUntil}` : "NOT REPORTED"}`);
  if (!ret || !ret.mode) {
    die("the object was written with no retention. The bucket has Object Lock enabled but this key\n" +
        "  is not applying it — the B2 application key needs the Object Lock (writeFileRetentions)\n" +
        "  capability, or the provider is ignoring the header.");
  }
  const probe = await s3.tryPermanentDelete(key, versionId);
  if (!probe.denied) {
    die(`THE LOCK IS NOT REAL. A version-addressed delete of the canary just succeeded (${probe.status}).\n` +
        `  Nothing was uploaded. Fix the bucket before this job runs again — a backup that can be\n` +
        `  deleted by the credential that writes it is not a backup.`);
  }
  ok(`lock proven: permanent delete of the canary refused (${probe.status} ${probe.code})`);
}
if (CHECK) { ok("--check: the destination is real, locked and versioned. Nothing uploaded."); process.exit(0); }

// ── 3. build the night's bundle ───────────────────────────────────────────────
const work = KEEP || mkdtempSync(path.join(tmpdir(), "augur-offsite-"));
const parts = [];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const run = (cmd, argv, env) => execFileSync(cmd, argv, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...env } });

// store — every space's live manifest and blobs, and (with --full) the workspace state
let stateSummary = null;
{
  const t0 = Date.now();
  const dir = path.join(work, "store");
  const engineDir = path.resolve(val("AUGUR_ENGINE_DIR") || path.join(ROOT, "engine"));
  const engineExport = path.join(engineDir, "scripts", "export.mjs");
  if (!existsSync(engineExport)) {
    die(`${engineExport} is missing — no engine to export with.\n` +
        `  In a deploy shell that means the submodule is not checked out; elsewhere, point\n` +
        `  AUGUR_ENGINE_DIR at a checkout of the engine.`);
  }
  // The token comes from AUGUR_TOKEN (CI) or a saved `augur login` (a laptop);
  // export.mjs resolves both and says so plainly when it finds neither.
  //
  // ⚠️ AUGUR_ORIGIN IS PASSED EXPLICITLY AND MUST STAY THAT WAY. Left to resolve itself,
  // the engine walks its own `.env.deploy` and the sibling deploy shells and can pick a
  // DIFFERENT instance than the one this run is filing a copy for — which is a copy of
  // the wrong site under the right tenant's prefix, in a bucket nobody can delete from.
  run("node", [engineExport, "--out", dir, ...(FULL ? ["--full"] : []), ...(HISTORY ? ["--history"] : [])],
      { AUGUR_ORIGIN: ORIGIN });

  // A copy that quietly omits a space is the one you discover is short on the day
  // you need it. `skipped` is how a space-scoped token loses `_engine` in silence.
  const meta = JSON.parse(readFileSync(path.join(dir, "export.json"), "utf8"));
  if ((meta.skipped || []).length) {
    die(`the store export SKIPPED ${meta.skipped.length} target(s) — AUGUR_TOKEN is not star-scoped:\n` +
        meta.skipped.map((s) => `    ${s.id}: ${s.reason}`).join("\n"));
  }
  // `full: false` on a run that asked for `--full` means the engine on the far side is
  // older than the state export. Silently filing that as a full copy is how a restore
  // discovers, a month later, that the roster was never in any of them.
  if (FULL && !meta.full) {
    die(`--full was requested and the copy came back content-only. The engine at ${engineDir}\n` +
        `  predates \`augur export --full\`. Update it, or run with --no-full and know what is missing.`);
  }
  if (FULL) {
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    // `absent` is the export saying "this family could not be enumerated here", which is
    // NOT the same as empty and is exactly what a restore will decline to put back. It is
    // recorded in the index so a copy's holes are readable off the index rather than only
    // by unpacking it.
    stateSummary = {
      families: Object.keys(state.families || {}).length,
      familyKeys: Object.keys(state.families || {}).sort(),
      entries: Object.fromEntries(Object.entries(state.families || {})
        .map(([k, v]) => [k, v && typeof v === "object" ? Object.keys(v).length : 1])),
      absent: state.absent || [],
      assets: (state.assets || []).length,
      workspace: state.workspace || null,
      generatedAt: state.generatedAt || null,
    };
    log(`state: ${stateSummary.families} famil(y/ies), ${stateSummary.assets} canvas image(s), ${stateSummary.absent.length} absent`);
    if (stateSummary.absent.length) log(`\x1b[33mabsent (not in this copy, and a restore will not put them back): ${stateSummary.absent.join(", ")}\x1b[0m`);
  }
  const tgz = path.join(work, "store.tar.gz");
  run("tar", ["-czf", tgz, "-C", dir, "."]);
  const buf = readFileSync(tgz);
  parts.push({
    name: "store.tar.gz", buf, contentType: "application/gzip",
    meta: {
      spaces: meta.spaces.map((s) => ({ id: s.id, version: s.version, dirty: !!s.source?.dirty })),
      blobs: meta.blobs, history: !!meta.history, exportedAt: meta.exportedAt,
      full: !!meta.full, state: stateSummary,
    },
  });
  log(`store: ${meta.spaces.length} space(s), ${meta.blobs} blobs → ${(buf.length / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const dirty = meta.spaces.filter((s) => s.source?.dirty).map((s) => s.id);
  if (dirty.length) log(`\x1b[33m${dirty.join(", ")} published from a dirty tree — those bytes exist in NO repository, this copy is the only one\x1b[0m`);
}

// kv — the mutable half
{
  const t0 = Date.now();
  const file = path.join(work, "kv.json");
  // Beside THIS file, not under the shell root: the two travel together as one tool,
  // and the shell they are pointed at may hold no scripts of its own at all.
  run("node", [path.join(HERE, "kv-export.mjs"), "--out", file]);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const buf = gzipSync(readFileSync(file));
  parts.push({
    name: "kv.json.gz", buf, contentType: "application/gzip",
    // `bytes` on every part means the stored object's size, so the meta uses its own
    // name for the uncompressed total rather than shadowing it.
    meta: { keys: doc.count, uncompressedBytes: doc.bytes, vanished: (doc.vanished || []).length, namespace: doc.namespace, at: doc.at },
  });
  log(`kv: ${doc.count} keys → ${(buf.length / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// roster + wiring — the deploy shell's own two files, when there is a shell here.
//
// ⚠️ A HOSTED SHELL'S identity.json IS `[]` AND THAT IS NOT AN ERROR. Its workspaces'
// members are rows in each workspace's Durable Object, carried by the `--full` half
// above. What this part is for is the SELF-HOSTED shape, where the file IS the roster.
// Absent, the part is skipped and the index says it was skipped — never silently.
{
  const present = ["identity.json", "deploy.config.json"].filter((f) => existsSync(path.join(ROOT, f)));
  if (!present.length) {
    log(`roster: no identity.json or deploy.config.json under ${ROOT} — this copy carries no shell wiring`);
  } else {
    const tgz = path.join(work, "roster.tar.gz");
    run("tar", ["-czf", tgz, "-C", ROOT, ...present]);
    const buf = readFileSync(tgz);
    let users = null;
    try { users = JSON.parse(readFileSync(path.join(ROOT, "identity.json"), "utf8")).length; } catch (e) {}
    parts.push({ name: "roster.tar.gz", buf, contentType: "application/gzip", meta: { users, files: present } });
    log(`roster: ${users === null ? "no identity.json" : `${users} user(s)`} → ${(buf.length / 1e3).toFixed(1)} kB`);
  }
}

const index = {
  format: 1,
  tenant: TENANT,
  slot: SLOT,
  origin: ORIGIN,
  takenAt: new Date().toISOString(),
  history: HISTORY,
  // Readable off the index without unpacking 100 MB, because "is the roster in this
  // copy" is a question asked under time pressure.
  full: FULL,
  state: stateSummary,
  lock: { mode: LOCK_MODE, retainUntil, days: RETAIN_DAYS, bucketLock: lock, versioning },
  parts: parts.map((p) => ({ name: p.name, bytes: p.buf.length, sha256: sha(p.buf), ...p.meta })),
  restore: "ops/offsite/README.md (andratwiro/augur-status); the long form is docs/restore-runbook.md in a deploy shell",
};

if (DRY) {
  console.log(JSON.stringify(index, null, 2));
  ok(`--dry-run: bundle built in ${work} (${(parts.reduce((n, p) => n + p.buf.length, 0) / 1e6).toFixed(2)} MB), nothing uploaded`);
  process.exit(0);
}

// ── 4. upload, index last ─────────────────────────────────────────────────────
// A dropped socket part way through the night's upload must not mean there is no copy
// of the night. Measured here on the first live run: Scaleway closed the connection
// after the whole 1.12 MB body had been written, and the same object went up first try
// on the retry. Three attempts with a short backoff, and the failure is still a failure
// — what is not acceptable is a red run that only ever needed to ask twice.
async function put(key, body, opts) {
  for (let attempt = 1; ; attempt++) {
    try { return await s3.putObject(key, body, opts); }
    catch (e) {
      if (attempt >= 3) throw e;
      log(`\x1b[33mupload of ${key} failed (${e.message || e}) — attempt ${attempt + 1} of 3\x1b[0m`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const t0 = Date.now();
const versions = {};
for (const p of parts) {
  const { versionId } = await put(`${PREFIX}/${p.name}`, p.buf, { contentType: p.contentType, ...lockOpts });
  versions[p.name] = versionId;
  log(`uploaded ${PREFIX}/${p.name}  ${(p.buf.length / 1e6).toFixed(2)} MB`);
}
// The index goes last and names the parts' version ids, so a half-finished upload
// leaves no object claiming to describe a complete copy.
index.versions = versions;
const indexBuf = Buffer.from(JSON.stringify(index, null, 2));
const indexPut = await put(`${PREFIX}/backup.json`, indexBuf, { contentType: "application/json", ...lockOpts });
ok(`uploaded ${PREFIX}/backup.json — ${(parts.reduce((n, p) => n + p.buf.length, 0) / 1e6).toFixed(2)} MB total in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── 5. last night's copy must be beyond this credential's reach ───────────────
// The canary proved new writes get locked. This proves the copies already sitting
// there cannot be taken away — which is the property the whole job is for.
{
  const { objects } = await s3.list(`tenants/${TENANT}/`);
  const priors = objects
    .filter((o) => o.key.endsWith("/backup.json") && o.key !== `${PREFIX}/backup.json`)
    .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  if (!priors.length) {
    log("no prior copy to test against — this is the first run. Tomorrow's run makes this assertion.");
  } else {
    const prior = priors[0];
    // Version-addressed delete needs the version id; read it off the object.
    const head = await s3.send("HEAD", prior.key, { expect: [200] });
    const vid = head.headers.get("x-amz-version-id");
    const probe = await s3.tryPermanentDelete(prior.key, vid);
    if (!probe.denied) {
      die(`LAST NIGHT'S COPY WAS DELETABLE and has just been deleted (${prior.key}).\n` +
          `  The canary passed and this did not, which means retention is being applied to new\n` +
          `  objects but not holding. Treat every stored copy as unprotected until this is fixed.`);
    }
    ok(`prior copy ${prior.key} is beyond reach: permanent delete refused (${probe.status} ${probe.code})`);
  }
}

if (!KEEP) rmSync(work, { recursive: true, force: true });
console.log(`${s3.host}/${BUCKET}/${PREFIX}  ${parts.length + 1} objects, locked ${LOCK_MODE} until ${retainUntil}`);
