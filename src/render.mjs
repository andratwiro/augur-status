// status.json + support.body.html  ->  docs/index.html + docs/support.html
//
// Everything is inlined. The rendered pages make ZERO network requests: no fonts,
// no scripts, no images from anywhere. A status page that needs a CDN to render is a
// status page with a second failure domain bolted to it.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..");

export const STATES = {
  operational: { label: "Operational", rank: 0, tone: "ok" },
  maintenance: { label: "Under maintenance", rank: 1, tone: "info" },
  degraded: { label: "Degraded", rank: 2, tone: "warn" },
  partial: { label: "Partial outage", rank: 3, tone: "bad" },
  outage: { label: "Outage", rank: 4, tone: "bad" },
};

const OVERALL = [
  { rank: 0, tone: "ok", line: "All systems operational" },
  { rank: 1, tone: "info", line: "Maintenance in progress" },
  { rank: 2, tone: "warn", line: "Some things are slower than they should be" },
  { rank: 3, tone: "bad", line: "Part of Augur is down" },
  { rank: 4, tone: "bad", line: "Augur is down" },
];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A tiny inline subset of markdown, so status notes can carry a link or a code
// span without anyone hand-writing HTML into status.json.
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function stamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return esc(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const CSS = `
:root{
  --paper:#fbfbfd; --card:#fff; --ink:#16171a; --muted:#5b626e; --faint:#9aa0ab;
  --line:rgba(16,17,26,.10); --peri:#4f46e5;
  --ok:#0f766e; --ok-bg:rgba(15,118,110,.10);
  --warn:#b45309; --warn-bg:rgba(180,83,9,.10);
  --bad:#b42318; --bad-bg:rgba(180,35,24,.10);
  --info:#4f46e5; --info-bg:rgba(79,70,229,.10);
  --radius:14px;
}
@media (prefers-color-scheme:dark){
  :root{
    --paper:#0e0f12; --card:#16181d; --ink:#eceef2; --muted:#a2a9b6; --faint:#6f7784;
    --line:rgba(255,255,255,.12); --peri:#8b93f5;
    --ok:#4ecdc0; --ok-bg:rgba(78,205,192,.12);
    --warn:#f0a83c; --warn-bg:rgba(240,168,60,.12);
    --bad:#ff8a80; --bad-bg:rgba(255,138,128,.12);
    --info:#8b93f5; --info-bg:rgba(139,147,245,.12);
  }
}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--paper); color:var(--ink);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased; padding:0 20px 72px;
}
.wrap{max-width:760px;margin:0 auto}
a{color:var(--peri)}
code{font:0.9em/1 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--line);padding:.15em .38em;border-radius:5px}

header.top{display:flex;align-items:center;gap:12px;padding:34px 0 26px;flex-wrap:wrap}
.mark{width:26px;height:26px;flex:none}
.brand{font-weight:640;letter-spacing:-.01em;font-size:17px}
.top nav{margin-left:auto;display:flex;gap:18px;font-size:14px}
.top nav a{color:var(--muted);text-decoration:none}
.top nav a:hover{color:var(--ink)}

.banner{
  border-radius:var(--radius); padding:22px 24px; display:flex; gap:16px; align-items:flex-start;
  border:1px solid var(--line);
}
.banner.ok{background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 26%,transparent)}
.banner.warn{background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 26%,transparent)}
.banner.bad{background:var(--bad-bg);border-color:color-mix(in srgb,var(--bad) 26%,transparent)}
.banner.info{background:var(--info-bg);border-color:color-mix(in srgb,var(--info) 26%,transparent)}
.banner h1{font-size:22px;line-height:1.25;letter-spacing:-.015em;font-weight:640}
.banner .when{color:var(--muted);font-size:13.5px;margin-top:5px}
.banner .note{margin-top:10px;font-size:15px}
.dot{width:12px;height:12px;border-radius:50%;flex:none;margin-top:7px}
.ok .dot{background:var(--ok)} .warn .dot{background:var(--warn)}
.bad .dot{background:var(--bad)} .info .dot{background:var(--info)}

h2.sec{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--faint);font-weight:620;margin:40px 0 12px}

.components{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);overflow:hidden}
.row{display:flex;gap:16px;align-items:baseline;padding:16px 20px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row .name{font-weight:580}
.row .blurb{color:var(--muted);font-size:14px;margin-top:3px}
.row .detail{font-size:14px;margin-top:6px}
.row .left{min-width:0;flex:1}
.pill{
  flex:none;font-size:12.5px;font-weight:600;padding:4px 11px;border-radius:999px;
  white-space:nowrap;border:1px solid transparent;
}
.pill.ok{color:var(--ok);background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 24%,transparent)}
.pill.warn{color:var(--warn);background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 24%,transparent)}
.pill.bad{color:var(--bad);background:var(--bad-bg);border-color:color-mix(in srgb,var(--bad) 24%,transparent)}
.pill.info{color:var(--info);background:var(--info-bg);border-color:color-mix(in srgb,var(--info) 24%,transparent)}

.incident{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);padding:20px 22px;margin-bottom:14px}
.incident h3{font-size:16.5px;font-weight:620;letter-spacing:-.01em}
.incident .meta{color:var(--muted);font-size:13.5px;margin-top:4px}
.incident ul{list-style:none;margin:14px 0 0;padding:0;border-left:2px solid var(--line)}
.incident li{padding:0 0 12px 16px;position:relative}
.incident li:last-child{padding-bottom:0}
.incident li time{display:block;color:var(--faint);font-size:12.5px;letter-spacing:.02em}
.quiet{color:var(--muted);font-size:15px}

.callout{border:1px solid var(--line);border-radius:var(--radius);padding:18px 22px;background:var(--card)}
.callout p+p{margin-top:10px}

.lede{font-size:18px;color:var(--muted);margin:6px 0 4px;max-width:60ch}
main h1{font-size:30px;letter-spacing:-.02em;line-height:1.15;font-weight:660;margin-top:8px}
main h2{font-size:19px;letter-spacing:-.01em;font-weight:640;margin:36px 0 10px}
main h3{font-size:16px;font-weight:640;margin-bottom:6px}
main p,main ul{margin-top:10px;max-width:66ch}
main ul{padding-left:20px}
main li{margin-top:6px}

table.contacts{border-collapse:collapse;margin-top:14px;width:100%}
table.contacts th{text-align:left;font-weight:600;padding:9px 16px 9px 0;vertical-align:top;white-space:nowrap}
table.contacts td{padding:9px 0;color:var(--muted);vertical-align:top}
table.contacts tr+tr th,table.contacts tr+tr td{border-top:1px solid var(--line)}
.scroll{overflow-x:auto}

.tiers{display:grid;gap:14px;margin-top:16px}
@media(min-width:640px){.tiers{grid-template-columns:1fr 1fr}}
.tier{border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;background:var(--card)}
.tier .promise{font-weight:620;color:var(--ink);margin-top:8px}
.tier p{font-size:14.5px}
.tier-paid{border-color:color-mix(in srgb,var(--peri) 34%,transparent)}

footer{margin-top:52px;padding-top:22px;border-top:1px solid var(--line);color:var(--faint);font-size:13.5px}
footer p+p{margin-top:8px}
footer a{color:var(--muted)}
`;

// The Augur eye, inline. Copied shape, no file to fetch.
const MARK = `<svg class="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
<path d="M2 16s5.2-8.5 14-8.5S30 16 30 16s-5.2 8.5-14 8.5S2 16 2 16Z" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/>
<circle cx="16" cy="16" r="3.6" fill="currentColor"/></svg>`;

function chrome({ title, description, body, nav }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='6' fill='%234f46e5'/%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top">${MARK}<span class="brand">Augur</span>
<nav>${nav}</nav>
</header>
<main>
${body}
</main>
<footer>
<p>This page is hosted on GitHub Pages, deliberately away from the Cloudflare
account that serves Augur. When Augur is down, this page is not.</p>
<p>Updates are written by hand by the person fixing the problem.
Source: <a href="https://github.com/andratwiro/augur-status">andratwiro/augur-status</a>.</p>
</footer>
</div>
</body>
</html>
`;
}

function componentRow(c) {
  const st = STATES[c.state] || STATES.operational;
  return `  <div class="row">
    <div class="left">
      <div class="name">${esc(c.name)}</div>
      ${c.blurb ? `<div class="blurb">${inline(c.blurb)}</div>` : ""}
      ${c.detail ? `<div class="detail">${inline(c.detail)}</div>` : ""}
    </div>
    <span class="pill ${st.tone}">${esc(st.label)}</span>
  </div>`;
}

function incidentCard(i) {
  const open = i.state !== "resolved";
  const meta = open
    ? `Started ${stamp(i.started)} — ongoing`
    : `${stamp(i.started)} → ${stamp(i.resolved)}`;
  const updates = (i.updates || [])
    .map((u) => `      <li><time>${stamp(u.at)}</time>${inline(u.text)}</li>`)
    .join("\n");
  return `  <article class="incident">
    <h3>${esc(i.title)}</h3>
    <div class="meta">${esc(meta)}${i.components && i.components.length ? " · " + esc(i.components.join(", ")) : ""}</div>
${updates ? `    <ul>\n${updates}\n    </ul>` : ""}
  </article>`;
}

export function renderStatus(status) {
  const worst = status.components.reduce(
    (m, c) => Math.max(m, (STATES[c.state] || STATES.operational).rank),
    0,
  );
  const open = (status.incidents || []).filter((i) => i.state !== "resolved");
  const overall = OVERALL[open.length && worst === 0 ? 2 : worst];
  const past = (status.incidents || []).filter((i) => i.state === "resolved").slice(0, 12);

  const body = `<section class="banner ${overall.tone}">
  <span class="dot"></span>
  <div>
    <h1>${esc(overall.line)}</h1>
    <div class="when">Checked and written by hand · ${esc(stamp(status.updated))}</div>
    ${status.note ? `<div class="note">${inline(status.note)}</div>` : ""}
  </div>
</section>

<h2 class="sec">Components</h2>
<div class="components">
${status.components.map(componentRow).join("\n")}
</div>

<h2 class="sec">${open.length ? "Open incident" + (open.length > 1 ? "s" : "") : "Incidents"}</h2>
${open.length ? open.map(incidentCard).join("\n") : ""}
${!open.length ? `<p class="quiet">Nothing open right now.</p>` : ""}

${past.length ? `<h2 class="sec">Recently resolved</h2>\n${past.map(incidentCard).join("\n")}` : ""}

<h2 class="sec">If something is broken</h2>
<div class="callout">
  <p>Write to <a href="mailto:hi@augur.works">hi@augur.works</a>. Tell us the URL
  and roughly when it stopped working — that is usually enough.</p>
  <p>How long you will wait for a reply, in writing:
  <a href="./support.html">response times</a>. Short version: paid workspaces get a
  human within two business days; free ones get best effort and no promise.</p>
</div>`;

  return chrome({
    title: "Augur status",
    description: "Current state of Augur's serving, login, publishing and canvas multiplayer.",
    nav: `<a href="./support.html">Getting help</a>`,
    body,
  });
}

export function renderSupport() {
  return chrome({
    title: "Augur — getting help",
    description: "Support contacts and the response times Augur actually commits to.",
    nav: `<a href="./">Status</a>`,
    body: readFileSync(join(ROOT, "src/support.body.html"), "utf8"),
  });
}

export function build() {
  const status = JSON.parse(readFileSync(join(ROOT, "status.json"), "utf8"));
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  writeFileSync(join(ROOT, "docs/index.html"), renderStatus(status));
  writeFileSync(join(ROOT, "docs/support.html"), renderSupport());
  // Machine-readable mirror, so a probe or a script can read the same truth.
  copyFileSync(join(ROOT, "status.json"), join(ROOT, "docs/status.json"));
  writeFileSync(join(ROOT, "docs/robots.txt"), "User-agent: *\nDisallow: /\n");
  // Tells GitHub Pages to serve the files as-is instead of running Jekyll over them.
  writeFileSync(join(ROOT, "docs/.nojekyll"), "");
  return status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build();
  console.log("rendered docs/index.html + docs/support.html");
}
