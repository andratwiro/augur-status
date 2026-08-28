// fetch-backup.mjs — get a night's copy back out of the locked bucket.
//
//   node scripts/fetch-backup.mjs --list
//   node scripts/fetch-backup.mjs --out /tmp/recover              the newest copy
//   node scripts/fetch-backup.mjs --out /tmp/recover --slot monthly
//   node scripts/fetch-backup.mjs --out /tmp/recover --at 2026-08-19
//
// Unpacks to a directory the recovery tools take directly:
//   <out>/store/      → `augur restore <out>/store`
//   <out>/kv.json     → `node scripts/restore-kv.mjs <out>/kv.json --into <ns>`
//   <out>/roster/     → identity.json + deploy.config.json
//   <out>/backup.json → the index this copy was written with
//
// Every part is checked against the sha256 the index recorded. A backup you cannot
// verify is a backup you are guessing about, and the guess is being made on the one
// day when guessing is most expensive.
//
// Needs only READ credentials. Keep a read-only key for this — the writing key
// belongs to CI, and a person recovering at 3am should not be holding it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3, discoverB2Endpoint } from "./lib/s3.mjs";

const ROOT = path.resolve(process.env.AUGUR_SHELL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const LIST = flag("--list");
const OUT = opt("--out");
const SLOT = opt("--slot");
const AT = opt("--at");

const log = (m) => console.error(`\x1b[36m[fetch]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[fetch] ${m}\x1b[0m`); process.exit(1); };

const val = (...names) => {
  for (const n of names) { const v = (process.env[n] || "").trim(); if (v && v !== "FILL_ME") return v; }
  return "";
};
const KEY_ID = val("BACKUP_S3_KEY_ID", "B2_KEY_ID");
const SECRET = val("BACKUP_S3_SECRET", "B2_APPLICATION_KEY");
const BUCKET = val("BACKUP_S3_BUCKET", "B2_BUCKET");
if (!KEY_ID || !SECRET || !BUCKET) die("need BACKUP_S3_KEY_ID / BACKUP_S3_SECRET / BACKUP_S3_BUCKET (or the B2_* names)");

// The shell is optional — see offsite-backup.mjs's header. `--tenant` first, because
// this command is typed by a person who knows which workspace they are recovering and
// may be nowhere near its shell.
let cfg = {};
if (existsSync(path.join(ROOT, "deploy.config.json"))) {
  try { cfg = JSON.parse(readFileSync(path.join(ROOT, "deploy.config.json"), "utf8")); } catch (e) {}
}
const TENANT = opt("--tenant") || val("BACKUP_TENANT") || cfg.spaces?.[0]?.id || "";
if (!TENANT) die("name the workspace: --tenant <id>  (or set BACKUP_TENANT)");

let ENDPOINT = val("BACKUP_S3_ENDPOINT");
if (!ENDPOINT) ENDPOINT = await discoverB2Endpoint(KEY_ID, SECRET).catch((e) => die(e.message));
const s3 = new S3({
  endpoint: ENDPOINT, bucket: BUCKET, keyId: KEY_ID, secret: SECRET,
  region: val("BACKUP_S3_REGION") || undefined,
  pathStyle: val("BACKUP_S3_PATH_STYLE") === "1",
});

// ── find the copies ───────────────────────────────────────────────────────────
const { objects } = await s3.list(`tenants/${TENANT}/`);
let copies = objects
  .filter((o) => o.key.endsWith("/backup.json"))
  .map((o) => {
    const m = o.key.match(/^tenants\/[^/]+\/([^/]+)\/([^/]+)\/backup\.json$/);
    return m ? { key: o.key, slot: m[1], day: m[2], lastModified: o.lastModified, size: o.size } : null;
  })
  .filter(Boolean)
  .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));

if (!copies.length) die(`no copies under tenants/${TENANT}/ in ${BUCKET}. Wrong tenant, wrong bucket, or the job has never run.`);
if (SLOT) copies = copies.filter((c) => c.slot === SLOT);
if (AT) copies = copies.filter((c) => c.day === AT);
if (!copies.length) die(`no copy matches${SLOT ? ` --slot ${SLOT}` : ""}${AT ? ` --at ${AT}` : ""}`);

if (LIST) {
  for (const c of copies) console.log(`${c.day}  ${c.slot.padEnd(8)}  ${c.lastModified}  ${c.key}`);
  console.log(`\n${copies.length} copy(ies) for tenant ${TENANT} in ${BUCKET}`);
  process.exit(0);
}
if (!OUT) die("name a destination: --out <dir>  (or --list to see what is there)");

// ── download and verify ───────────────────────────────────────────────────────
const chosen = copies[0];
const started = Date.now();
log(`${chosen.key}  (${chosen.slot}, taken ${chosen.lastModified})`);
const dir = path.dirname(chosen.key);
const index = JSON.parse((await s3.getObject(chosen.key)).toString("utf8"));
log(`index: ${index.parts.map((p) => `${p.name} ${(p.bytes / 1e6).toFixed(2)}MB`).join(" · ")}`);

// This unpacks into a clean directory, which means emptying it — and this command is
// typed at 3am by someone who has just lost a production bucket. Refuse anything that
// already has something in it, rather than being the second disaster of the evening.
if (existsSync(OUT) && readdirSync(OUT).length && !flag("--force")) {
  die(`${OUT} is not empty. Name a new directory, or pass --force to empty this one.`);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "backup.json"), JSON.stringify(index, null, 2));

for (const part of index.parts) {
  // Read the exact version the index named. Without this, a copy written after the
  // index — by a rerun, or by someone else — is what you would get back instead.
  const buf = await s3.getObject(`${dir}/${part.name}`, { versionId: index.versions?.[part.name] || null });
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== part.sha256) die(`${part.name}: sha256 ${got.slice(0, 16)}… does not match the index's ${part.sha256.slice(0, 16)}…. This copy is corrupt — try an older one.`);
  log(`${part.name}: ${(buf.length / 1e6).toFixed(2)} MB, sha256 verified`);

  if (part.name === "store.tar.gz") {
    const d = path.join(OUT, "store");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(OUT, "store.tar.gz"), buf);
    execFileSync("tar", ["-xzf", path.join(OUT, "store.tar.gz"), "-C", d]);
    rmSync(path.join(OUT, "store.tar.gz"));
  } else if (part.name === "roster.tar.gz") {
    const d = path.join(OUT, "roster");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(OUT, "roster.tar.gz"), buf);
    execFileSync("tar", ["-xzf", path.join(OUT, "roster.tar.gz"), "-C", d]);
    rmSync(path.join(OUT, "roster.tar.gz"));
  } else if (part.name === "kv.json.gz") {
    writeFileSync(path.join(OUT, "kv.json"), gunzipSync(buf));
  } else {
    writeFileSync(path.join(OUT, part.name), buf);
  }
}

const kv = JSON.parse(readFileSync(path.join(OUT, "kv.json"), "utf8"));
const store = JSON.parse(readFileSync(path.join(OUT, "store", "export.json"), "utf8"));
let state = null;
if (existsSync(path.join(OUT, "store", "state.json"))) {
  state = JSON.parse(readFileSync(path.join(OUT, "store", "state.json"), "utf8"));
}
let rosterUsers = null;
if (existsSync(path.join(OUT, "roster", "identity.json"))) {
  try { rosterUsers = JSON.parse(readFileSync(path.join(OUT, "roster", "identity.json"), "utf8")).length; } catch (e) {}
}
log(`unpacked in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(
  `${OUT}\n` +
  `  store   ${store.spaces.map((s) => `${s.id} v${s.version}`).join(", ")} · ${store.blobs} blobs · taken ${store.exportedAt}\n` +
  // The one line that says whether the roster, the invites, the publish tokens, the
  // comments and the boards are in here at all. A content-only copy is a real backup of
  // a real thing and it is not a backup of a workspace, and the difference has to be
  // legible before somebody restores from it, not after.
  (state
    ? `  state   ${Object.keys(state.families || {}).length} famil(y/ies), ${(state.assets || []).length} image(s)` +
      `${(state.absent || []).length ? ` · \x1b[33mabsent: ${state.absent.join(", ")}\x1b[0m` : ""}\n`
    : `  state   \x1b[33mNONE — this copy is published content only (taken without --full)\x1b[0m\n`) +
  // `binary` is absent on a copy taken before values that are not UTF-8 text were
  // carried as base64 — and on such a copy every canvas image is a ruin, so saying
  // "format 1" here is saying the thing an operator needs before they rely on it.
  `  kv      ${kv.count} keys · ${kv.format >= 2 ? `${kv.binary || 0} binary` : "format 1: canvas images NOT usable"}` +
  ` · taken ${kv.at} · from namespace ${kv.namespace || "?"}\n` +
  `  roster  ${rosterUsers === null ? "not in this copy (no shell wiring)" : `${rosterUsers} user(s)`}`);
