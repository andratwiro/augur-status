// kv-backup.mjs — nightly, BINARY-SAFE copy of an Augur instance's KV namespace to
// a local directory, with rotation. Instance-neutral: everything comes from env.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… AUGUR_KV_NS=… \
//     node ops/kv-backup.mjs --dir /var/lib/augur-backups/<instance>/kv
//
//   … --keep 30            dated copies to retain (default 30)
//   … --keep-monthly 12    copies taken on the 1st, retained separately (default 12)
//   … --check              list and classify, write nothing
//   … --restore <file> --into <namespace-id>    replay a copy (see the bottom half)
//
// ── WHY THIS EXISTS RATHER THAN THE WORKFLOW ────────────────────────────────────
//
// KV is the only copy of the review record — comment threads, canvas boards, dev
// statuses, pins, renames, the user roster and the password store — and Cloudflare
// offers no point-in-time restore. The instance's own kv-backup.yml does this
// nightly on GitHub Actions; when Actions cannot run, nothing does.
//
// ── WHY NOT THE WORKFLOW'S DESTINATION ──────────────────────────────────────────
//
// kv-backup.yml commits the export to an orphan `kv-backups` branch in the deploy
// shell. Do not reproduce that. A public FORK of the engine once carried 24 daily
// exports of a client's production KV — real names, personal addresses, internal
// discussion, a users:secrets entry — reachable with no authentication, and because
// GitHub shares objects across a fork network it stayed fetchable through the
// PARENT repo's URL after the branch was deleted. Only a Support purge closes that.
//
// An export of this namespace is a CREDENTIAL (it holds `users:secrets` password
// hashes and `publish:tokens` bearer tokens). It belongs on a filesystem, mode 600,
// outside every git tree. This script refuses to write inside one.
//
// ── WHY "BINARY-SAFE" IS IN THE NAME ────────────────────────────────────────────
//
// Every export path in this stack — kv-backup.yml's `curl -o` + jq --rawfile, the
// engine's /__admin/backup, and scripts/kv-export.mjs — reads each value as UTF-8
// TEXT. KV stores arbitrary bytes: `basset:` (uploaded images) and `avatar:` values
// are raw image bytes. Decoding those as UTF-8 replaces every invalid sequence with
// U+FFFD, and U+FFFD does not decode back. Those keys were in the backup by NAME
// and their contents were already gone.
//
// So each value is fetched as bytes and STRICTLY round-tripped: decode UTF-8 with
// fatal:true, re-encode, compare byte for byte. Anything that survives is stored as
// text in `data` (identical to the old envelope). Anything that does not is stored
// base64 in `binary`, and named in `binaryKeys`.
//
// Binary values live in a SEPARATE top-level field on purpose. An older restore
// reading only `data` will now OMIT those keys rather than write replacement
// characters over real images: absent is recoverable, corrupt is not, and a restore
// that silently overwrites good bytes with U+FFFD is the failure this fixes.
// `--restore` below handles both halves.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────
//
// This is an INTERIM. The real answer is plan item D-2: one nightly copy to
// versioned, object-locked, off-site storage, where last night's copy cannot be
// deleted tonight by anything holding today's credentials — including this box, and
// including whoever compromises it. A local copy on a single machine protects
// against Cloudflare losing the namespace. It does not protect against this machine.

import { mkdir, writeFile, readFile, readdir, rm, stat, symlink, unlink, link } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const DIR = opt("--dir");
const KEEP = Number(opt("--keep", "30"));
const KEEP_MONTHLY = Number(opt("--keep-monthly", "12"));
const CHECK = flag("--check");
const RESTORE = opt("--restore");
const INTO = opt("--into");
const FORCE = flag("--force");

const ACC = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOK = process.env.CLOUDFLARE_API_TOKEN;
const NS = process.env.AUGUR_KV_NS || process.env.KV_NAMESPACE_ID || process.env.GV_KV_NS;
const LABEL = process.env.AUGUR_INSTANCE || "instance";

const log = (m) => console.error(`\x1b[36m[kv-backup]\x1b[0m ${m}`);
const die = (m) => { log(`\x1b[31m${m}\x1b[0m`); process.exit(1); };

if (!ACC || !TOK) die("need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID");
if (!NS) die("need AUGUR_KV_NS — the namespace id this instance's worker is bound to");

const API = `https://api.cloudflare.com/client/v4/accounts/${ACC}/storage/kv/namespaces`;
const H = { authorization: `Bearer ${TOK}` };

// ── the export is a credential: never let it land in a repo ─────────────────────
function refuseGitTree(dir) {
  let p = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(p, ".git"))) {
      die(`${dir} is inside a git tree (${p}). This export holds password hashes and ` +
          `publish tokens; it must not be committable. Point --dir somewhere outside git.`);
    }
    const up = path.dirname(p);
    if (up === p) return;
    p = up;
  }
}

// ── restore ─────────────────────────────────────────────────────────────────────
if (RESTORE) {
  if (!INTO) die("name the target namespace: --into <namespace-id> (never implicit)");
  if (INTO === NS && !FORCE) {
    die("--into is this instance's LIVE namespace. A drill restores into a fresh one. " +
        "If overwriting live is genuinely what you mean, add --force.");
  }
  const raw = RESTORE.endsWith(".gz")
    ? JSON.parse((await gunzip(await readFile(RESTORE))).toString("utf8"))
    : JSON.parse(await readFile(RESTORE, "utf8"));
  const envelope = raw && typeof raw === "object" && raw.data && typeof raw.data === "object";
  const data = envelope ? raw.data : raw;
  const binary = (envelope && raw.binary) || {};
  const expirations = (envelope && raw.expirations) || {};
  if (envelope && raw.complete === false) die(`${RESTORE} says complete:false — this copy is short. Refusing.`);

  const pairs = [
    ...Object.entries(data).map(([key, value]) => ({ key, value })),
    // base64:true tells the bulk API the value is base64 of the RAW BYTES, which is
    // the only way an image gets back into KV as the image it was.
    ...Object.entries(binary).map(([key, value]) => ({ key, value, base64: true })),
  ];
  if (!pairs.length) die(`${RESTORE} holds zero keys — refusing to "restore" nothing`);
  log(`${RESTORE}: ${pairs.length} keys (${Object.keys(binary).length} binary), taken ${raw.at || "?"}`);

  const probe = await fetch(`${API}/${INTO}/keys?limit=10`, { headers: H });
  const pj = await probe.json().catch(() => ({}));
  if (!probe.ok || !pj.success) die(`target namespace ${INTO} is not readable → ${probe.status}`);
  if ((pj.result || []).length && !FORCE) {
    die(`target namespace ${INTO} already holds keys. A fresh-namespace restore expects an empty one. Add --force.`);
  }

  const now = Math.floor(Date.now() / 1000) + 120;
  const BATCH = 5000;
  let written = 0;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const body = pairs.slice(i, i + BATCH).map((p) => {
      const exp = Number(expirations[p.key] || 0);
      return exp > now ? { ...p, expiration: exp } : p;
    });
    const res = await fetch(`${API}/${INTO}/bulk`, {
      method: "PUT", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success) die(`bulk write at ${i} → ${res.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
    written += body.length;
    log(`${written}/${pairs.length} keys written`);
  }
  console.log(`${INTO}  ${written} keys restored`);
  process.exit(0);
}

if (!DIR && !CHECK) die("name a destination: --dir <dir>  (outside any git tree)");
if (DIR) refuseGitTree(DIR);

// ── list ────────────────────────────────────────────────────────────────────────
const started = Date.now();
const keys = [];
let cursor = "";
for (;;) {
  const url = `${API}/${NS}/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const res = await fetch(url, { headers: H });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.success) die(`list → ${res.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  for (const k of j.result || []) keys.push(k);
  cursor = j.result_info?.cursor || "";
  if (!cursor) break;
}
log(`${keys.length} keys listed in namespace ${NS}`);

// A namespace that lists zero keys is either the wrong id or a catastrophe. Either
// way, writing an empty file called "backup" is the worst of the three options.
if (!keys.length) die("the namespace listed ZERO keys — wrong namespace id, or the data is gone. Refusing to write an empty backup.");

// ── read every value as BYTES, and classify by round-trip ───────────────────────
const DEC = new TextDecoder("utf-8", { fatal: true });
const ENC = new TextEncoder();

function roundTrips(buf) {
  let text;
  try { text = DEC.decode(buf); } catch (e) { return null; }   // not valid UTF-8 at all
  const back = ENC.encode(text);
  if (back.length !== buf.length) return null;
  for (let i = 0; i < back.length; i++) if (back[i] !== buf[i]) return null;
  return text;
}

const data = {};
const binary = {};
const expirations = {};
const vanished = [];
let bytes = 0;
const queue = [...keys];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const k = queue.pop();
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await fetch(`${API}/${NS}/values/${encodeURIComponent(k.name)}`, { headers: H }); break; }
      catch (e) { if (attempt >= 2) die(`read ${k.name}: ${e.message} — refusing to write a short backup`); }
    }
    // A key that vanished between the list and the read is NAMED, not dropped —
    // rate-limit keys carry TTLs and do this routinely. The distinction is the whole
    // difference between "was not in the namespace" and "this backup lost it".
    if (res.status === 404) { vanished.push(k.name); continue; }
    if (!res.ok) die(`read ${k.name} → ${res.status} — refusing to write a short backup`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = roundTrips(buf);
    if (text === null) binary[k.name] = buf.toString("base64");
    else data[k.name] = text;
    if (k.expiration) expirations[k.name] = k.expiration;
    bytes += buf.length;
  }
}));

const binaryKeys = Object.keys(binary).sort();
const count = Object.keys(data).length + binaryKeys.length;
log(`${count} keys read, ${binaryKeys.length} of them BINARY (base64), ${(bytes / 1e6).toFixed(2)} MB raw`);
if (binaryKeys.length) {
  const classes = {};
  for (const k of binaryKeys) { const c = k.split(":")[0]; classes[c] = (classes[c] || 0) + 1; }
  log(`binary key classes: ${Object.entries(classes).map(([c, n]) => `${c}:${n}`).join(", ")} ` +
      `— these are the keys a UTF-8 export was silently losing`);
}
if (vanished.length) log(`${vanished.length} vanished between list and read (TTL): ${vanished.slice(0, 3).join(", ")}…`);

const doc = {
  format: 2,
  at: new Date().toISOString(),
  instance: LABEL,
  namespace: NS,
  data,
  binary,
  binaryKeys,
  expirations,
  vanished,
  count,
  binaryCount: binaryKeys.length,
  bytes,
  complete: true,
  notice:
    "CREDENTIAL. Holds users:secrets (password hashes) and publish:tokens (bearer tokens " +
    "that can overwrite published content). Mode 600, never in a git tree, never in a " +
    "GitHub artifact or branch. || format 2: `data` holds values that round-trip as UTF-8; " +
    "`binary` holds base64 of the RAW BYTES for values that do not (uploaded images under " +
    "basset:/avatar:). A format-1 reader sees only `data` and will OMIT the binary keys — " +
    "absent, not corrupted. Restore both halves with `node ops/kv-backup.mjs --restore <file> --into <ns>`.",
};

if (CHECK) {
  log(`--check: would write ${count} keys (${binaryKeys.length} binary), ${(bytes / 1e6).toFixed(2)} MB raw. Nothing written.`);
  console.log(JSON.stringify({ count, binaryCount: binaryKeys.length, bytes, vanished: vanished.length }, null, 2));
  process.exit(0);
}

// ── write, 600, dated, gzipped ──────────────────────────────────────────────────
const today = doc.at.slice(0, 10);
await mkdir(DIR, { recursive: true, mode: 0o700 });
await mkdir(path.join(DIR, "monthly"), { recursive: true, mode: 0o700 });
const file = path.join(DIR, `kv-${today}.json.gz`);
const gz = await gzip(Buffer.from(JSON.stringify(doc)), { level: 6 });
await writeFile(file, gz, { mode: 0o600 });
const onDisk = (await stat(file)).size;
log(`wrote ${file} — ${(onDisk / 1e6).toFixed(2)} MB gzipped`);

// latest -> today, so a restore never has to guess which file is newest.
try { await unlink(path.join(DIR, "latest.json.gz")); } catch (e) {}
await symlink(path.basename(file), path.join(DIR, "latest.json.gz"));

// The 1st of the month is HARD-LINKED into monthly/ — same inode, no extra bytes,
// and it survives the daily prune. The old copy is the one that matters against a
// quiet compromise: anything that corrupts the namespace on a Tuesday is in every
// copy taken after it, so a rolling month of dailies protects you from accidents
// and not from something you notice late. A year of monthlies does.
if (today.endsWith("-01")) {
  const m = path.join(DIR, "monthly", `kv-${today}.json.gz`);
  try { await link(file, m); log(`monthly slot: ${m}`); } catch (e) { if (e.code !== "EEXIST") throw e; }
}

// ── rotate ──────────────────────────────────────────────────────────────────────
async function prune(dir, keep) {
  const files = (await readdir(dir)).filter((f) => /^kv-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    await rm(path.join(dir, f));
    log(`pruned ${path.join(dir, f)}`);
  }
  return Math.min(files.length, keep);
}
const dailies = await prune(DIR, KEEP);
const monthlies = await prune(path.join(DIR, "monthly"), KEEP_MONTHLY);

// ── dead-man ────────────────────────────────────────────────────────────────────
// Written on every successful run. /opt/monitoring's vitals-watch reads its mtime,
// so a job that stops running looks different from a job reporting good news.
const statusPath = path.join(DIR, "status.json");
await writeFile(statusPath, JSON.stringify({
  job: "kv-backup",
  instance: LABEL,
  at: doc.at,
  ok: true,
  keys: count,
  binaryKeys: binaryKeys.length,
  vanished: vanished.length,
  rawBytes: bytes,
  fileBytes: onDisk,
  file,
  retained: { daily: dailies, monthly: monthlies },
  tookMs: Date.now() - started,
}, null, 2) + "\n", { mode: 0o600 });

log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${dailies} daily + ${monthlies} monthly copies retained`);
console.log(file);
