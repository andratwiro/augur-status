#!/usr/bin/env node
// Cloudflare notification policies, as code, for every account Augur runs on.
//
//   node ops/cf-alerts.mjs --check      what exists vs what should
//   node ops/cf-alerts.mjs --apply      create what is missing (never deletes)
//
// Accounts are declared by env, one pair per account, so a new account is a config
// line and not a code change:
//
//   CF_ACCOUNTS="hosted,delta"
//   CF_HOSTED_TOKEN=…  CF_HOSTED_ACCOUNT=…  CF_HOSTED_EMAIL=…
//   CF_DELTA_TOKEN=…   CF_DELTA_ACCOUNT=…   CF_DELTA_EMAIL=…
//
// Alerting on one account and not the other is not "mostly covered" — it is a blind
// spot with a green dashboard in front of it, which is worse than no alerting at all.
//
// TOKEN SCOPE. Reading policies needs nothing special; creating one needs
// **Account · Notifications · Edit**. A token without it fails with a bare
// `10000 Authentication error` on POST while GET keeps working, which reads exactly
// like a bug in this script. It is not. --check names the account and the missing
// permission instead of guessing.

const API = "https://api.cloudflare.com/client/v4";

// What every Cloudflare account behind Augur should be shouting about.
// `filters` follow the shapes in /alerting/v3/available_alerts.
const WANTED = [
  {
    key: "workers-errors",
    name: "Augur — Workers errors",
    description:
      "A Workers Observability alert rule fired: error rate or invocation failures on a worker. Also fires on return to normal.",
    alert_type: "workers_observability_alert",
    filters: { status: ["FIRING_FAILED", "NORMAL"] },
  },
  {
    key: "pages-failures",
    name: "Augur — Pages deployment failures",
    description: "A Pages deployment failed. The chrome or the worker did not ship.",
    alert_type: "pages_event_alert",
    filters: { event: ["deployment.failure"] },
  },
  {
    key: "cloudflare-incident",
    name: "Augur — Cloudflare is having an incident",
    description:
      "Cloudflare itself is degraded. Knowing this before the users do is the difference between an explanation and a mystery.",
    alert_type: "incident_alert",
    filters: { incident_impact: ["INCIDENT_IMPACT_MAJOR", "INCIDENT_IMPACT_CRITICAL"] },
  },
];

const APPLY = process.argv.includes("--apply");

function accounts() {
  const names = (process.env.CF_ACCOUNTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) fail("set CF_ACCOUNTS, e.g. CF_ACCOUNTS=hosted,delta");
  return names.map((n) => {
    const P = "CF_" + n.toUpperCase().replace(/-/g, "_") + "_";
    const a = {
      name: n,
      token: process.env[P + "TOKEN"],
      id: process.env[P + "ACCOUNT"],
      email: process.env[P + "EMAIL"],
    };
    for (const k of ["token", "id", "email"]) {
      if (!a[k]) fail(`${n}: missing ${P}${k.toUpperCase() === "ID" ? "ACCOUNT" : k.toUpperCase()}`);
    }
    return a;
  });
}

function fail(msg) {
  console.error("error: " + msg);
  process.exit(1);
}

async function cf(acct, path, init = {}) {
  const r = await fetch(`${API}/accounts/${acct.id}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${acct.token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await r.json().catch(() => ({ success: false, errors: [{ message: "non-JSON reply" }] }));
  return { status: r.status, body };
}

async function run() {
  let missingPermission = false;
  for (const acct of accounts()) {
    console.log(`\n── ${acct.name} (${acct.id})`);

    const got = await cf(acct, "alerting/v3/policies");
    if (!got.body.success) {
      console.log(`   cannot read policies: ${JSON.stringify(got.body.errors)}`);
      console.log(`   needs: Account · Notifications · Read`);
      missingPermission = true;
      continue;
    }
    const have = got.body.result || [];
    const byType = new Set(have.map((p) => p.alert_type));

    const avail = await cf(acct, "alerting/v3/available_alerts");
    const offered = new Set(
      Object.values((avail.body && avail.body.result) || {}).flat().map((a) => a.type),
    );

    const dest = await cf(acct, "alerting/v3/destinations/eligible");
    const eligible = Object.entries((dest.body && dest.body.result) || {})
      .filter(([, v]) => v.eligible).map(([k]) => k);
    console.log(`   destinations available: ${eligible.join(", ") || "none"}`);
    if (!eligible.includes("webhooks")) {
      console.log("   (webhooks and PagerDuty need a paid Cloudflare plan — email it is)");
    }

    for (const w of WANTED) {
      if (!offered.has(w.alert_type)) {
        console.log(`   skip ${w.key}: this account is not offered "${w.alert_type}"`);
        continue;
      }
      if (byType.has(w.alert_type)) {
        console.log(`   ok   ${w.key}: already configured`);
        continue;
      }
      if (!APPLY) {
        console.log(`   MISSING ${w.key} — would create "${w.name}" → ${acct.email}`);
        continue;
      }
      const made = await cf(acct, "alerting/v3/policies", {
        method: "POST",
        body: JSON.stringify({
          name: w.name,
          description: w.description,
          enabled: true,
          alert_type: w.alert_type,
          mechanisms: { email: [{ id: acct.email }] },
          filters: w.filters,
        }),
      });
      if (made.body.success) {
        console.log(`   made ${w.key}: ${made.body.result.id}`);
      } else {
        const msg = JSON.stringify(made.body.errors);
        console.log(`   FAIL ${w.key}: HTTP ${made.status} ${msg}`);
        if (/Authentication error/.test(msg)) {
          console.log("        → the token is missing Account · Notifications · Edit.");
          console.log("          Cloudflare dashboard → My Profile → API Tokens → edit the");
          console.log("          token → add that permission row → Continue → Save.");
          missingPermission = true;
        }
      }
    }
  }

  if (missingPermission) {
    console.log("\nAt least one account could not be configured for lack of a token permission.");
    console.log("Partial alerting is a blind spot with a green dashboard in front of it — fix the");
    console.log("token and re-run rather than calling this done.");
    process.exit(2);
  }
  if (!APPLY) console.log("\n(nothing changed — re-run with --apply)");
}

run().catch((e) => fail(e.message));
