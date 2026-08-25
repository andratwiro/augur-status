#!/usr/bin/env python3
"""Synthetic probes for an Augur instance: does it SERVE, can you SIGN IN, can you PUBLISH.

Runs from cron on a machine that is not Cloudflare, so a Cloudflare incident cannot
take down the thing watching for it. Stdlib only — no venv to rot.

    augur-probe.py                run every probe due right now
    augur-probe.py --report       run everything, alert nothing, print the table
    augur-probe.py --commit       force the slow-lane publish commit this run
    augur-probe.py --test-alert   prove the phone alert works

Three probes, because two of them lie by omission:

  serving   GET /  → 200 and a fingerprint that only a composed page contains.
            Catches: the worker is gone, DNS is wrong, the gate 500s, Cloudflare
            is serving its own error page.

  login     POST /__auth with a dedicated VIEWER account → 303 + a session cookie.
            Catches: KV unreachable (the password store fails closed, so everyone
            is locked out while the homepage still looks perfect).

  publish   The write path, in two lanes.
            Fast lane, every run: auth + `check` (reads every live manifest out of
            R2) + a blob PUT (a real R2 write) + `manifest` + `/_build.json`.
            Slow lane, hourly: re-commit the LIVE manifest to itself, unchanged,
            and confirm /_build.json advances. That is a genuine end-to-end publish
            — CAS, the unpublish guard, composition, the manifest write, routing,
            the cache purge — that changes not one served byte.

The blob the fast lane writes is CONSTANT, so content addressing makes it the same
object every time instead of a new one every three minutes forever.

The slow lane's commit carries `baseVersion`, so if a real publish lands in the
same instant the store refuses the probe (409 stale-base) rather than the probe
overwriting a person. A raced probe is a PASS, not a failure — nothing was lost,
which is the whole point of the check.

Config: /etc/augur-probes.env (see augur-probes.env.example). Never in git.
"""

import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CONF = os.environ.get("AUGUR_PROBE_CONF", "/etc/augur-probes.env")
STATE_DIR = os.environ.get("AUGUR_PROBE_STATE", "/var/lib/augur-probes")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
STATUS_FILE = os.path.join(STATE_DIR, "status.json")

UA = "augur-uptime-probe/1 (+https://andratwiro.github.io/augur-status/)"
TIMEOUT = 25
FAILS_BEFORE_ALERT = 2          # one blip is weather; two in a row is a problem
PROBE_BLOB = b"augur uptime probe\n"   # constant on purpose: one object, forever

REPORT = "--report" in sys.argv
FORCE_COMMIT = "--commit" in sys.argv


# ---------------------------------------------------------------- config

def load_conf(path):
    conf = {}
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                conf[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    conf.update({k: v for k, v in os.environ.items()
                 if k.startswith(("T_", "TG_", "NTFY_", "COMMIT_", "TARGETS"))})
    return conf


CONF_D = load_conf(CONF)


def cfg(key, default=""):
    return CONF_D.get(key, default)


def targets():
    out = []
    for name in [t.strip() for t in cfg("TARGETS", "").split(",") if t.strip()]:
        p = "T_" + name.upper().replace("-", "_") + "_"
        origin = cfg(p + "ORIGIN")
        if not origin:
            continue
        out.append({
            "name": name,
            "origin": origin.rstrip("/"),
            "expect": cfg(p + "EXPECT", "Augur"),
            "space": cfg(p + "SPACE"),
            "token": cfg(p + "TOKEN"),
            "login_email": cfg(p + "LOGIN_EMAIL"),
            "login_pass": cfg(p + "LOGIN_PASS"),
        })
    return out


# ---------------------------------------------------------------- alerting

def notify(text):
    """Phone. Telegram is the channel the box already uses; ntfy is optional."""
    sent = False
    tok, chat = cfg("TG_BOT_TOKEN"), cfg("TG_CHAT_ID")
    if tok and chat:
        body = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
        try:
            urllib.request.urlopen(
                urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % tok,
                                       data=body, headers={"User-Agent": UA}),
                timeout=15)
            sent = True
        except Exception as e:
            log("telegram send failed: %s" % e)
    ntfy = cfg("NTFY_URL")
    if ntfy:
        try:
            urllib.request.urlopen(
                urllib.request.Request(ntfy, data=text.encode(),
                                       headers={"User-Agent": UA, "Title": "Augur", "Priority": "high"}),
                timeout=15)
            sent = True
        except Exception as e:
            log("ntfy send failed: %s" % e)
    if not sent:
        log("NO ALERT CHANNEL CONFIGURED — would have sent: " + text)


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line)
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(os.path.join(STATE_DIR, "probe.log"), "a") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------- http

CTX = ssl.create_default_context()


def http(method, url, *, headers=None, data=None, timeout=TIMEOUT):
    h = {"User-Agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=timeout, context=CTX)
        return r.status, r.read(), dict(r.headers), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers), (time.time() - t0) * 1000


def as_json(body, what):
    """A JSON API that answers with HTML is answering with something else entirely —
    a gate page, a Cloudflare error, a redirect to a login. Say that, don't stack-trace."""
    try:
        return json.loads(body)
    except ValueError:
        head = body[:80].decode("utf-8", "replace").replace("\n", " ")
        raise ValueError("%s did not return JSON (%d bytes, starts %r)" % (what, len(body), head))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


def http_noredirect(method, url, *, headers=None, data=None):
    h = {"User-Agent": UA}
    h.update(headers or {})
    op = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    t0 = time.time()
    try:
        r = op.open(req, timeout=TIMEOUT)
        return r.status, r.read(), dict(r.headers), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers), (time.time() - t0) * 1000


# ---------------------------------------------------------------- probes

def probe_serving(t):
    try:
        code, body, _, ms = http("GET", t["origin"] + "/")
    except Exception as e:
        return False, "unreachable: %s" % e, None
    if code >= 400:
        return False, "HTTP %d" % code, ms
    text = body.decode("utf-8", "replace")
    if t["expect"] not in text:
        return False, ("HTTP %d but the page did not contain %r (%d bytes) — a Cloudflare "
                       "error page, or a build that shipped nothing"
                       % (code, t["expect"], len(body))), ms
    return True, "HTTP %d, fingerprint present" % code, ms


def probe_login(t):
    if not (t["login_email"] and t["login_pass"]):
        return None, "no probe account configured", None
    form = urllib.parse.urlencode({
        "email": t["login_email"], "password": t["login_pass"], "redirect": "/"}).encode()
    try:
        code, body, headers, ms = http_noredirect(
            "POST", t["origin"] + "/__auth", data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"})
    except Exception as e:
        return False, "unreachable: %s" % e, None
    cookie = headers.get("Set-Cookie", "")
    if code == 303 and "gv_user=" in cookie:
        return True, "session issued", ms
    if code == 429:
        return None, "rate limited by the gate (not a failure)", ms
    return False, "HTTP %d, no session cookie — the password store may be unreachable" % code, ms


def probe_publish_fast(t):
    """Auth, a real R2 read, a real R2 write, and the public build stamp."""
    if not (t["token"] and t["space"]):
        return None, "no publish token configured", None
    base = "%s/__publish/%s" % (t["origin"], t["space"])
    auth = {"Authorization": "Bearer " + t["token"], "Content-Type": "application/json"}
    t0 = time.time()

    code, body, _, _ = http("POST", base + "/check", headers=auth, data=b'{"files":{}}')
    if code != 200:
        return False, "check → HTTP %d %s" % (code, body[:120].decode("utf-8", "replace")), None
    chk = as_json(body, "check")
    live = chk.get("liveVersion")
    if not isinstance(live, int):
        return False, "check returned no liveVersion", None

    h = hashlib.sha256(PROBE_BLOB).hexdigest()
    code, body, _, _ = http("PUT", base + "/blob/" + h, headers={"Authorization": auth["Authorization"]},
                            data=PROBE_BLOB)
    if code not in (200, 201, 204):
        return False, "blob PUT → HTTP %d %s (R2 writes failing)" % (code, body[:120].decode("utf-8", "replace")), None

    code, body, _, _ = http("GET", base + "/manifest", headers={"Authorization": auth["Authorization"]})
    if code != 200:
        return False, "manifest read → HTTP %d" % code, None
    man = as_json(body, "manifest")

    code, body, _, _ = http("GET", t["origin"] + "/_build.json")
    if code != 200:
        return False, "/_build.json → HTTP %d" % code, None
    stamp = as_json(body, "/_build.json").get("spaces", {}).get(t["space"], {})
    if stamp.get("version") != man.get("version"):
        return False, ("the store says v%s but /_build.json says v%s — serving is stale"
                       % (man.get("version"), stamp.get("version"))), None

    return True, "v%d, store read+write ok" % live, (time.time() - t0) * 1000


def probe_publish_commit(t):
    """The real thing: publish the live manifest to itself and watch it land."""
    if not (t["token"] and t["space"]):
        return None, "no publish token configured", None
    base = "%s/__publish/%s" % (t["origin"], t["space"])
    auth = {"Authorization": "Bearer " + t["token"], "Content-Type": "application/json"}

    code, body, _, _ = http("GET", base + "/manifest", headers={"Authorization": auth["Authorization"]})
    if code != 200:
        return False, "manifest read → HTTP %d" % code, None
    man = as_json(body, "manifest")
    v = man.get("version")
    if not isinstance(v, int):
        return False, "manifest has no version", None

    payload = dict(man)
    payload["baseVersion"] = v
    for k in ("version", "publishedAt", "publishedBy"):
        payload.pop(k, None)

    t0 = time.time()
    code, body, _, _ = http("POST", base + "/commit", headers=auth,
                            data=json.dumps(payload).encode(), timeout=60)
    if code == 409:
        # A person published between our read and our write. The store protected
        # them, which is exactly the behaviour under test.
        return True, "raced a real publish (409 stale-base) — guard working", None
    if code != 200:
        return False, "commit → HTTP %d %s" % (code, body[:200].decode("utf-8", "replace")), None
    got = as_json(body, "commit").get("version")
    if got != v + 1:
        return False, "commit returned v%s, expected v%d" % (got, v + 1), None

    for _ in range(20):
        code, body, _, _ = http("GET", t["origin"] + "/_build.json")
        if code == 200:
            live = as_json(body, "/_build.json").get("spaces", {}).get(t["space"], {}).get("version")
            if live == got:
                ms = (time.time() - t0) * 1000
                return True, "published v%d, live in %.0fms" % (got, ms), ms
        time.sleep(1)
    return False, "committed v%d but /_build.json never caught up in 20s" % got, None


# ---------------------------------------------------------------- run

def main():
    state = {}
    try:
        with open(STATE_FILE) as fh:
            state = json.load(fh)
    except Exception:
        pass

    if "--test-alert" in sys.argv:
        notify("Augur probes: test alert. If you are reading this on your phone, the channel works.")
        print("sent")
        return 0

    commit_every = int(cfg("COMMIT_EVERY_MIN", "60") or 60)
    last_commit = state.get("_last_commit", 0)
    due = (time.time() - last_commit) >= commit_every * 60
    # --report is a dry run, and the commit lane is the one probe that writes.
    # It only runs under --report if you ask for it by name.
    do_commit = FORCE_COMMIT or (due and not REPORT)

    results = {}
    problems = []
    recoveries = []

    # A probe that raises is a probe that alerts nobody, which is worse than the
    # outage it was watching for. Every unexpected exception becomes a plain failure.
    def safe(fn, t):
        try:
            return fn(t)
        except Exception as e:
            return False, "probe crashed: %s: %s" % (type(e).__name__, e), None

    for t in targets():
        checks = [("serving", safe(probe_serving, t)), ("login", safe(probe_login, t)),
                  ("publish", safe(probe_publish_fast, t))]
        if do_commit:
            checks.append(("publish-commit", safe(probe_publish_commit, t)))
        results[t["name"]] = {}
        for probe, (ok, detail, ms) in checks:
            results[t["name"]][probe] = {
                "ok": ok, "detail": detail, "ms": round(ms) if ms else None}
            if ok is None:
                continue
            key = "%s/%s" % (t["name"], probe)
            rec = state.get(key, {"fails": 0, "alerted": False})
            if ok:
                if rec.get("alerted"):
                    recoveries.append("%s recovered — %s" % (key, detail))
                state[key] = {"fails": 0, "alerted": False}
            else:
                rec["fails"] = rec.get("fails", 0) + 1
                if rec["fails"] >= FAILS_BEFORE_ALERT and not rec.get("alerted"):
                    problems.append("%s FAILING (%dx) — %s" % (key, rec["fails"], detail))
                    rec["alerted"] = True
                state[key] = rec

    if do_commit and not REPORT:
        state["_last_commit"] = time.time()

    # Roll the per-probe truth up into the four things the status page names.
    components = {}
    for tname, probes in results.items():
        for probe, r in probes.items():
            comp = "publish" if probe.startswith("publish") else probe
            if r["ok"] is False:
                components[comp] = "outage"
            elif r["ok"] is True:
                components.setdefault(comp, "operational")

    payload = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "components": components,
        "targets": results,
    }

    if REPORT:
        print(json.dumps(payload, indent=2))
        for p in problems:
            print("WOULD ALERT:", p)
        return 0

    os.makedirs(STATE_DIR, exist_ok=True)
    # Touched on EVERY run, pass or fail — this is also the dead-man file
    # vitals-watch watches, and a prober that stops running must look different
    # from a prober reporting good news.
    with open(STATUS_FILE, "w") as fh:
        json.dump(payload, fh, indent=2)
    with open(STATE_FILE, "w") as fh:
        json.dump(state, fh)

    for line in problems:
        log("ALERT " + line)
    for line in recoveries:
        log("RECOVERED " + line)
    if problems:
        notify("Augur is broken:\n\n" + "\n".join(problems)
               + "\n\nSay so: bin/status set <component> outage \"...\"\n"
                 "https://andratwiro.github.io/augur-status/")
    if recoveries:
        notify("Augur recovered:\n\n" + "\n".join(recoveries))

    ok = all(r["ok"] is not False for probes in results.values() for r in probes.values())
    log("run %s%s" % ("ok" if ok else "PROBLEMS", " (+commit lane)" if do_commit else ""))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
