// kv-export.mjs — copy a whole KV namespace to one JSON document.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… AUGUR_KV_NS=… \
//     node scripts/kv-export.mjs --out kv.json
//
// This is the account-credential twin of the engine's `GET /__admin/backup`, and it
// emits THE SAME document on purpose: {format, at, data, expirations, vanished,
// count, bytes, complete}. One shape means one restore path — `restore-kv.mjs` reads
// a copy taken by CI and a copy an admin pulled from a laptop without caring which
// is which.
//
// NO PREFIX FILTER, same reasoning as the engine's: enumerating the key classes we
// know about is how a backup silently stops covering the class someone adds next.
//
// Values are copied VERBATIM and never re-parsed. Most are JSON, but a backup that
// parses is a backup that can fail on something it did not expect.
//
// ⚠️ VERBATIM MEANS BYTES, NOT TEXT. This read used to be `res.text()`, which answers a
// JPEG with U+FFFD wherever the bytes are not valid UTF-8 — silently, and irreversibly.
// Canvas board images live in this namespace (`basset:`), and they came back longer than
// the original, different, and no longer matching the checksum in their own key name.
// Read the arrayBuffer and let scripts/lib/kv-codec.mjs decide: text stays a JSON string,
// anything else rides as a base64 marker. Never reintroduce `.text()`.
//
// ⚠️ The output holds `users:secrets` (password hashes and reset tombstones) and
// `publish:tokens` (bearer tokens that can overwrite published content). It is a
// credential. Treat every destination for it as one.

import { writeFile } from "node:fs/promises";
import { KV_BACKUP_FORMAT, encodeKvValue } from "./lib/kv-codec.mjs";

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const OUT = opt("--out");

const ACC = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOK = process.env.CLOUDFLARE_API_TOKEN;
const NS = process.env.AUGUR_KV_NS || process.env.KV_NAMESPACE_ID || process.env.GV_KV_NS;

const log = (m) => console.error(`\x1b[36m[kv-export]\x1b[0m ${m}`);
const die = (m) => { log(m); process.exit(1); };

if (!ACC || !TOK) die("need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID");
if (!NS) die("need AUGUR_KV_NS — the namespace id this instance's worker is bound to");
if (!OUT) die("name a destination: --out <file>");

// Overridable so the export can be driven end to end against a local stand-in: that a
// value which is not UTF-8 comes out of the wire intact is exactly what cannot be proven
// by reading the code, and proving it must not need a Cloudflare account or a network.
const API_ROOT = process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";
const API = `${API_ROOT}/accounts/${ACC}/storage/kv/namespaces/${NS}`;
const H = { authorization: `Bearer ${TOK}` };

const started = Date.now();

// 1. list every key (cursor-paginated, 1000/page)
const keys = [];
let cursor = "";
for (;;) {
  const url = `${API}/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const res = await fetch(url, { headers: H });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.success) die(`list → ${res.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  for (const k of j.result || []) keys.push(k);
  cursor = j.result_info?.cursor || "";
  if (!cursor) break;
}
log(`${keys.length} keys listed`);

// A namespace that lists zero keys is either the wrong id or a catastrophe. Either
// way, writing an empty file called "backup" is the worst of the three options.
if (!keys.length) die("the namespace listed ZERO keys — wrong namespace id, or the data is gone. Refusing to write an empty backup.");

// 2. read every value. A read FAILURE aborts; a key that vanished between the list
// and the read is named, not dropped (rate-limit keys carry TTLs and do this
// routinely). The distinction is the whole difference between "this key was not in
// the namespace" and "this backup lost it".
const data = {};
const expirations = {};
const vanished = [];
let bytes = 0;
let binary = 0;
const queue = [...keys];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const k = queue.pop();
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${API}/values/${encodeURIComponent(k.name)}`, { headers: H });
        break;
      } catch (e) {
        if (attempt >= 2) die(`read ${k.name}: ${e.message} — refusing to write a short backup`);
      }
    }
    if (res.status === 404) { vanished.push(k.name); continue; }
    if (!res.ok) die(`read ${k.name} → ${res.status} — refusing to write a short backup`);
    const raw = Buffer.from(await res.arrayBuffer());
    const v = encodeKvValue(raw);
    if (typeof v !== "string") binary++;
    data[k.name] = v;
    if (k.expiration) expirations[k.name] = k.expiration;
    bytes += raw.length; // BYTES, not string length: the two differ on every non-ASCII
                         // value and are unrelated on a binary one.
  }
}));

const doc = {
  format: KV_BACKUP_FORMAT,
  at: new Date().toISOString(),
  data,
  expirations,
  vanished,
  count: Object.keys(data).length,
  bytes,
  // How many values could not be carried as text. An operator can tell at a glance
  // whether a copy predates the codec (0 on a namespace holding board images) or
  // genuinely holds none.
  binary,
  complete: true,
  // Not in the engine's envelope; harmless there, useful here, because a copy taken
  // by CI is the one most likely to be read by someone who does not know which
  // namespace it came from.
  namespace: NS,
};

await writeFile(OUT, JSON.stringify(doc), "utf8");
log(`${doc.count} keys, ${(bytes / 1e6).toFixed(2)} MB, ${binary} binary, ${vanished.length} vanished, ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (vanished.length) log(`vanished (listed, then expired before the read): ${vanished.slice(0, 5).join(", ")}${vanished.length > 5 ? ` +${vanished.length - 5}` : ""}`);
console.log(OUT);
