#!/usr/bin/env python3
"""Synthetic probes for an Augur instance: does it SERVE, can you SIGN IN, can you PUBLISH.

Runs from cron on a machine that is not Cloudflare, so a Cloudflare incident cannot
take down the thing watching for it. Stdlib only — no venv to rot.

    augur-probe.py                run every probe due right now
    augur-probe.py --report       run everything, alert nothing, print the table
    augur-probe.py --commit       force the slow-lane publish commit this run
    augur-probe.py --health       force the slow-lane deploy-health checks this run
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

── AND A FOURTH LANE: DEPLOY HEALTH (opt-in, per target, every 6h) ──────────────

The three above answer "is it working right now". They cannot see the failures
that are silent by nature — a site that serves perfectly while the thing that
keeps it current has stopped. Those used to be a GitHub Actions canary
(health.yml) in each instance's deploy shell; an instance whose Actions cannot
run has no canary at all, which is how two dead backups went unnoticed for days.

  dirty-publish   /_build.json says a space is serving a working-tree publish and
                  has been for longer than the grace window. Those exact bytes
                  exist in NO repository — they cannot be reviewed or rebuilt.

  chrome-drift    a space's baked chrome (builtWithEngine) is older than the
                  deployed engine, past the re-bake window. The re-bake was missed.

  engine-stale    the pinned engine is N commits behind the public engine's main,
                  past a per-target allowance. THIS IS THE ONE THAT NAGS: an
                  outage alerts once and gets fixed, but a pin that stopped moving
                  is a slow rot nobody is paged for, so it re-notifies weekly
                  until it is either fixed or the allowance is widened on purpose.

  quota           free-tier daily burn vs every cap this stack can hit: KV reads
                  (100k/day), KV writes (1k/day — the tightest ratio at normal
                  usage), Pages Function invocations (100k/day) and Durable Object
                  requests (100k/day). Past a cap it is a hard degrade for the rest
                  of the UTC day: logins show the reset notice, boards go
                  read-only, routes error, canvas rooms drop. Warn well below, so
                  a new burner is found while there are still hours to find it.

Every one of these is OFF unless that target configures it, so adding the lane
changes nothing for a target that does not ask for it. They report separately from
the three core probes and never colour the public status page's components — a
stale pin is not an outage, and saying it is would train people to ignore the page.

Config: /etc/augur-probes.env (see augur-probes.env.example). Never in git.
"""

import calendar
import hashlib
import json
import os
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# IPv4 only. The box has no global IPv6 route, and urllib tries every address and
# reports the LAST error — so every IPv4 failure surfaced as the IPv6 attempt's
# "[Errno 101] Network is unreachable" and hid what had actually happened (seven
# evenings of that message between 26 Aug and 5 Sep 2026, all of them IPv4 connect
# timeouts). Falls through to whatever the resolver has if there is no A record.
_getaddrinfo = socket.getaddrinfo
def _v4_first(*a, **kw):
    res = _getaddrinfo(*a, **kw)
    return [r for r in res if r[0] == socket.AF_INET] or res
socket.getaddrinfo = _v4_first

CONF = os.environ.get("AUGUR_PROBE_CONF", "/etc/augur-probes.env")
STATE_DIR = os.environ.get("AUGUR_PROBE_STATE", "/var/lib/augur-probes")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
STATUS_FILE = os.path.join(STATE_DIR, "status.json")

UA = "augur-uptime-probe/1 (+https://andratwiro.github.io/augur-status/)"
TIMEOUT = 25
FAILS_BEFORE_ALERT = 2          # one blip is weather; two in a row is a problem
PROBE_BLOB = b"augur uptime probe\n"   # constant on purpose: one object, forever

# The three probes the public status page speaks in. Anything else — the deploy
# health lane below — is reported and alerted but never rolled into a component:
# a pin that has stopped moving is not an outage, and a status page that says it is
# teaches people to ignore it.
CORE_PROBES = ("serving", "login", "publish", "publish-commit")

# Neutral hosts, deliberately NOT on Cloudflare. If none of them answers, the box
# itself has no route out — that is the homelab's outage, not Augur's, and it must
# not page as "Augur is broken" for every lane of every target and then "recovered"
# for every lane, all evening (30–31 Aug 2026: ~150 such alerts in two days, every
# one of them "[Errno 101] Network is unreachable" while every other monitor on the
# box timed out at the same minute). A Cloudflare outage still pages: these hosts
# are reachable then, and the targets are not.
CANARY_URLS = ("https://www.google.com/generate_204", "https://api.github.com/")

# The other way a box can be cut off: the canaries answer, and Cloudflare does not.
# From a Spanish ISP that is a LaLiga IP block — court-ordered, per Cloudflare IP,
# for the duration of a match (https://hayahora.futbol) — and very rarely Cloudflare
# itself. Either way it is not Augur, and 26 Aug–5 Sep 2026 showed what paging it
# as Augur looks like: seven evenings, 55 messages in one afternoon, every window a
# kickoff. So a run in which at least PATH_MIN_TARGETS targets cannot even open a
# TCP connection mutes those lanes (their counters untouched, like a skipped run),
# pages ONCE for the episode after the usual two consecutive runs, and once when it
# clears. A lane that connects and answers wrongly still pages as before — that is
# the failure this probe exists for, and a block never looks like it.
PATH_MIN_TARGETS = 2
PATH_MARKERS = ("unreachable:", "URLError", "timed out", "TimeoutError", "Connection refused",
                "Connection reset", "Network is unreachable", "No route to host")


def is_path_failure(detail):
    return any(m in (detail or "") for m in PATH_MARKERS)


def tcp_open(origin, timeout=5):
    """Can this box open a TCP connection to the origin at all? A raw connect, so a
    worker that accepts and then hangs (a real outage) is told apart from an IP that
    is dropped on the way (a block)."""
    u = urllib.parse.urlsplit(origin)
    try:
        socket.create_connection((u.hostname, u.port or (443 if u.scheme == "https" else 80)),
                                 timeout=timeout).close()
        return True
    except OSError:
        return False

# A failure alerts once and then stays quiet until it recovers, which is right for
# an outage: somebody is already on it. It is wrong for a slow rot — an engine pin
# that stopped moving is still wrong next Tuesday and nobody was reminded. These
# probes re-notify on the interval instead of latching.
RENOTIFY_HOURS = {"engine-stale": 168}   # weekly

REPORT = "--report" in sys.argv
FORCE_COMMIT = "--commit" in sys.argv
FORCE_HEALTH = "--health" in sys.argv


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
            # Per target, because instances take an engine bump at their own pace and
            # two of them can legitimately disagree about the name mid-migration.
            #
            # A LIST, comma-separated, and the default holds every name a currently
            # supported engine issues. That is what makes an engine rename a non-event
            # here: the probe runs every 3 minutes and pages on two consecutive
            # failures, so a single accepted name would make the ~1 minute between
            # "probe updated" and "engine deployed" (in whichever order they land) a
            # coin flip on waking someone up. Accepting the old name AND the new one
            # spans the deploy with no red minutes at all, and still catches the thing
            # worth catching: a cookie named something nobody shipped.
            # ⏳ Drop a name from this default one week after the last instance issuing
            # it has deployed an engine that no longer does — the same condition, and
            # the same order, as LEGACY_USER_COOKIES in the engine's src/_worker.js.
            # Pin a single name per target with T_<NAME>_COOKIE_NAME to assert harder.
            "cookie_names": [n.strip() for n in cfg(
                p + "COOKIE_NAME", "__Host-augur_user,__Host-gv_user").split(",") if n.strip()],

            # ── the publish COMMIT lane, per target ──────────────────────────────
            # On by default: it is the only check that proves the whole write path.
            # Turn it off (T_<NAME>_COMMIT=0) for an instance where a person is
            # publishing constantly and an hourly version bump attributed to a probe
            # would be noise in THEIR history. The fast lane still exercises R2 reads
            # and writes every three minutes, so turning this off costs the CAS /
            # composition / cache-purge coverage, not the store coverage.
            "commit": cfg(p + "COMMIT", "1") not in ("0", "no", "false", ""),

            # ── deploy health lane, all opt-in ───────────────────────────────────
            # Grace windows in seconds; a value of 0 disables that check entirely.
            "dirty_grace": int(cfg(p + "DIRTY_GRACE_SECONDS", "0") or 0),
            "rebake_grace": int(cfg(p + "REBAKE_GRACE_SECONDS", "0") or 0),
            # The PUBLIC engine repo and how far behind main this instance may sit.
            # 0 = do not check. An instance that takes engine bumps weekly should say
            # so with a generous number rather than by being unmonitored.
            "engine_repo": cfg(p + "ENGINE_REPO", "andratwiro/augur"),
            "engine_max_behind": int(cfg(p + "ENGINE_MAX_BEHIND", "0") or 0),
            # Cloudflare account analytics. Needs Account Analytics:Read; the token is
            # read-only against usage counters and cannot change anything.
            "cf_token": cfg(p + "CF_TOKEN"),
            "cf_account": cfg(p + "CF_ACCOUNT"),
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


def box_online():
    """True if at least one neutral canary answers at all — any HTTP status counts."""
    for u in CANARY_URLS:
        try:
            http("GET", u, timeout=10)
            return True
        except Exception:
            continue
    return False


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
    if code == 429:
        return None, "rate limited by the gate (not a failure)", ms
    if code != 303:
        return False, "HTTP %d, no session cookie — the password store may be unreachable" % code, ms

    # Assert the cookie's name EXACTLY, not as a substring.
    #
    # This read `"gv_user=" in cookie`, which cannot tell `gv_user` from
    # `__Host-gv_user` — the second contains the first. So the probe reported green
    # through the rename whether it had worked, silently failed, or half-landed: the
    # one change most able to break login was the one change this probe could not see.
    #
    # The name is configuration because it is still moving (the engine reads several
    # names during a migration window, so it can change again at no cost), and it is a
    # SET rather than one string so a rename lands without a red minute — see
    # cookie_names in targets(). The `__Host-` prefix is asserted separately and
    # unconditionally: it is a security property, not a name. A browser refuses to store
    # a `__Host-` cookie that carries a Domain attribute, which is what stops one
    # workspace tossing a cookie at its neighbour on a shared apex — losing the prefix
    # would reopen that quietly.
    names = t.get("cookie_names") or ["__Host-augur_user"]
    issued = cookie.split("=", 1)[0].strip() if "=" in cookie else ""
    if issued not in names:
        return False, "session cookie is %r, expected one of %s — set cookie_name if this was deliberate" % (
            issued or "(none)", ", ".join(names)), ms
    if not issued.startswith("__Host-"):
        return False, "session cookie %r lost its __Host- prefix — a sibling host can now shadow it" % issued, ms
    return True, "session issued as %s" % issued, ms


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


# ------------------------------------------------- deploy health (slow lane)

def _stamp(t):
    """The public build stamp, cache-busted. No credential needed."""
    code, body, _, _ = http("GET", "%s/_build.json?t=%d" % (t["origin"], time.time()))
    if code != 200:
        raise ValueError("/_build.json → HTTP %d" % code)
    return as_json(body, "/_build.json")


def _age(iso):
    """Seconds since an ISO stamp; a missing or unparseable one reads as ancient,
    never as an exception — a bad date must not take the rest of the lane down."""
    if not iso:
        return 10 ** 9
    try:
        # timegm, not mktime: the stamp is UTC and mktime would read it as local,
        # which silently shifts every age by the box's offset and by DST.
        return max(0, int(time.time() - calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))))
    except Exception:
        return 10 ** 9


def probe_dirty_publish(t):
    """Live content built from an uncommitted working tree, left standing.

    Fine for an hour of hands-on work — those bytes exist in no repository, so once
    the session ends nobody can review, rebuild or roll forward from them."""
    grace = t.get("dirty_grace") or 0
    if not grace:
        return None, "not configured (set DIRTY_GRACE_SECONDS)", None
    stamp = _stamp(t)
    bad = []
    for sid, s in (stamp.get("spaces") or {}).items():
        if not s.get("dirty"):
            continue
        age = _age(s.get("publishedAt"))
        if age > grace:
            bad.append("%s has been serving a working-tree publish for %dh (base %s) — those exact "
                       "bytes exist in NO repository" % (sid, age // 3600, (s.get("sha") or "?")[:12]))
    if bad:
        return False, "; ".join(bad), None
    return True, "no dirty publish past its window", None


def probe_chrome_drift(t):
    """A space's baked chrome older than the deployed engine, past the re-bake window.

    Page-level chrome is baked at publish time, so an engine bump leaves a space on
    the old chrome until something republishes it. Runtime chrome hides this at serve
    time for marker-era pages; baked generated markup does not catch up on its own."""
    grace = t.get("rebake_grace") or 0
    if not grace:
        return None, "not configured (set REBAKE_GRACE_SECONDS)", None
    stamp = _stamp(t)
    eng = (stamp.get("engine") or {}).get("sha") or ""
    if not eng:
        return None, "stamp carries no engine.sha", None
    eng_age = _age((stamp.get("engine") or {}).get("publishedAt"))
    if eng_age <= grace:
        return True, "engine deployed %dh ago — inside the re-bake window" % (eng_age // 3600), None
    bad = []
    for sid, s in (stamp.get("spaces") or {}).items():
        bw = s.get("builtWithEngine") or ""
        if bw == eng or s.get("dirty"):
            continue
        bad.append("%s serves baked chrome %s but the engine is %s (deployed %dh ago)"
                   % (sid, (bw or "<none>")[:12], eng[:12], eng_age // 3600))
    if bad:
        return False, "; ".join(bad) + " — the re-bake was missed", None
    return True, "all baked chrome matches engine %s" % eng[:12], None


def probe_engine_stale(t):
    """How far the pinned engine is behind the PUBLIC engine's main.

    An instance whose pin moves by CI stops moving the moment CI stops, and nothing
    about the running site looks different. Unauthenticated GitHub compare — the
    engine repo is public, so this needs no credential on this box."""
    allowed = t.get("engine_max_behind") or 0
    if not allowed:
        return None, "not configured (set ENGINE_MAX_BEHIND)", None
    stamp = _stamp(t)
    live = (stamp.get("engine") or {}).get("sha") or ""
    if not live:
        return None, "stamp carries no engine.sha", None
    url = "https://api.github.com/repos/%s/compare/%s...main" % (t["engine_repo"], live)
    code, body, _, _ = http("GET", url, headers={"Accept": "application/vnd.github+json"})
    if code == 403:
        # Unauthenticated rate limit. Not knowing is not the same as being current,
        # but it is also not an alert worth waking anyone for.
        return None, "GitHub rate-limited the compare (no token needed, just try later)", None
    if code == 404:
        return False, ("%s does not contain the pinned engine sha %s — the pin points at a commit "
                       "the public repo cannot see" % (t["engine_repo"], live[:12])), None
    if code != 200:
        return None, "compare → HTTP %d" % code, None
    cmp_ = as_json(body, "compare")
    behind = cmp_.get("ahead_by") or 0     # commits main is ahead of the pin
    if behind <= allowed:
        return True, "engine pin %s is %d commit(s) behind main (allowance %d)" % (live[:12], behind, allowed), None
    return False, ("engine pin %s is %d commits behind %s main (allowance %d) — the pin is not moving "
                   "on its own; deploy it by hand or fix whatever bumps it"
                   % (live[:12], behind, t["engine_repo"], allowed)), None


# Free-tier daily caps, and what actually breaks at each one. The warn lines sit
# well below so a NEW burner is found while there are hours left in the UTC day.
QUOTA_CAPS = [
    ("KV reads",             "reads",  60000, 100000, "logins show the reset notice and boards go read-only"),
    ("KV writes",            "writes",   500,   1000, "publishes, overlay edits and invites fail"),
    ("Function invocations", "fns",    60000, 100000, "worker routes error out"),
    ("DO requests",          "dos",    60000, 100000, "canvas realtime rooms drop"),
]


def probe_quota(t):
    """Free-tier daily burn, account-wide, against every cap this stack can hit."""
    tok, acct = t.get("cf_token"), t.get("cf_account")
    if not (tok and acct):
        return None, "not configured (set CF_TOKEN + CF_ACCOUNT)", None
    today = time.strftime("%Y-%m-%d", time.gmtime())
    query = ('query { viewer { accounts(filter: {accountTag: "%s"}) {'
             ' kv: kvOperationsAdaptiveGroups(limit: 10, filter: {date: "%s"})'
             ' { dimensions { actionType } sum { requests } }'
             ' fns: pagesFunctionsInvocationsAdaptiveGroups(limit: 10, filter: {date: "%s"}) { sum { requests } }'
             ' dos: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: {date: "%s"}) { sum { requests } }'
             ' } } }' % (acct, today, today, today))
    code, body, _, _ = http("POST", "https://api.cloudflare.com/client/v4/graphql",
                            headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
                            data=json.dumps({"query": query}).encode())
    if code != 200:
        return False, "Cloudflare GraphQL → HTTP %d — quota burn is UNMONITORED" % code, None
    j = as_json(body, "graphql")
    try:
        acc = j["data"]["viewer"]["accounts"][0]
    except Exception:
        return False, ("Cloudflare analytics query returned no account (token missing Account "
                       "Analytics:Read?) — quota burn is UNMONITORED"), None
    kv = acc.get("kv") or []
    got = {
        "reads":  sum(g["sum"]["requests"] for g in kv if g.get("dimensions", {}).get("actionType") == "read"),
        "writes": sum(g["sum"]["requests"] for g in kv if g.get("dimensions", {}).get("actionType") == "write"),
        "fns":    sum(g["sum"]["requests"] for g in (acc.get("fns") or [])),
        "dos":    sum(g["sum"]["requests"] for g in (acc.get("dos") or [])),
    }
    hot = []
    for label, key, warn, cap, consequence in QUOTA_CAPS:
        if got[key] > warn:
            hot.append("%s at %d/%d today (UTC) — past the %d warn line; at the cap %s for the rest of "
                       "the day" % (label, got[key], cap, warn, consequence))
    summary = ", ".join("%s %d" % (l, got[k]) for l, k, _, _, _ in QUOTA_CAPS)
    if hot:
        return False, "; ".join(hot), None
    return True, summary, None


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

    if not box_online():
        # Skip the run without touching the failure counters: a lane that was fine
        # before the box lost its uplink is still fine, and one that was failing keeps
        # its count for when the uplink returns. The dead-man file is still stamped
        # so a skipped run and a dead prober stay distinguishable.
        log("box offline — no canary host reachable; run skipped so a homelab outage "
            "does not page as an Augur one")
        if not REPORT:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(STATUS_FILE, "w") as fh:
                json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                           "skipped": "box offline", "components": {}, "targets": {}}, fh, indent=2)
        return 0

    commit_every = int(cfg("COMMIT_EVERY_MIN", "60") or 60)
    last_commit = state.get("_last_commit", 0)
    due = (time.time() - last_commit) >= commit_every * 60
    # --report is a dry run, and the commit lane is the one probe that writes.
    # It only runs under --report if you ask for it by name.
    do_commit = FORCE_COMMIT or (due and not REPORT)

    # The health lane is read-only, so --report may run it freely. It is slow (a
    # GitHub compare + a Cloudflare GraphQL round trip per target) and answers a
    # question that changes on the scale of hours, not minutes.
    health_every = int(cfg("HEALTH_EVERY_MIN", "360") or 360)
    do_health = FORCE_HEALTH or REPORT or (time.time() - state.get("_last_health", 0)) >= health_every * 60

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

    collected = []
    for t in targets():
        checks = [("serving", safe(probe_serving, t)), ("login", safe(probe_login, t)),
                  ("publish", safe(probe_publish_fast, t))]
        if do_commit and t.get("commit"):
            checks.append(("publish-commit", safe(probe_publish_commit, t)))
        if do_health:
            checks += [("dirty-publish", safe(probe_dirty_publish, t)),
                       ("chrome-drift", safe(probe_chrome_drift, t)),
                       ("engine-stale", safe(probe_engine_stale, t)),
                       ("quota", safe(probe_quota, t))]
        collected.append((t, checks))

    # Cut off from Cloudflare, not from the internet? Only targets whose front door
    # failed the network way are re-tested, with a raw connect, so the answer is
    # about the path and not about what the worker said.
    cut = [t["name"] for t, checks in collected
           if any(p == "serving" and ok is False and is_path_failure(d) for p, (ok, d, _) in checks)
           and not tcp_open(t["origin"])]
    blocked = len(collected) >= PATH_MIN_TARGETS and len(cut) >= PATH_MIN_TARGETS
    path = state.get("_path") or {"runs": 0, "alerted": False, "since": 0}
    path_msgs = []
    if blocked:
        path["runs"] = path.get("runs", 0) + 1
        path["since"] = path.get("since") or time.time()
        if path["runs"] >= FAILS_BEFORE_ALERT and not path.get("alerted"):
            path["alerted"] = True
            path_msgs.append(
                "Cloudflare is unreachable from the homelab — %d of %d targets, since %s UTC.\n\n"
                "Not Augur. From here this is almost always a LaLiga IP block during a match "
                "(https://hayahora.futbol), rarely Cloudflare itself. Those lanes are muted until "
                "it clears; nothing to do."
                % (len(cut), len(collected), time.strftime("%H:%M", time.gmtime(path["since"]))))
    else:
        if path.get("alerted"):
            path_msgs.append("Cloudflare is reachable from the homelab again, after %d min. Probes resume."
                             % round((time.time() - path["since"]) / 60))
        path = {"runs": 0, "alerted": False, "since": 0}
    state["_path"] = path

    for t, checks in collected:
        results[t["name"]] = {}
        for probe, (ok, detail, ms) in checks:
            if blocked and ok is False and is_path_failure(detail):
                ok, detail = None, "muted — Cloudflare unreachable from the homelab, not counted: " + detail
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
                # The slow lane runs every 6h, so "two consecutive failures" would be
                # half a day of silence. These checks measure a state, not a blip —
                # a stale pin is stale on the first look — so they alert immediately.
                threshold = 1 if probe not in CORE_PROBES else FAILS_BEFORE_ALERT
                renotify = RENOTIFY_HOURS.get(probe, 0) * 3600
                stale_alert = renotify and (time.time() - rec.get("alerted_at", 0)) >= renotify
                if rec["fails"] >= threshold and (not rec.get("alerted") or stale_alert):
                    problems.append("%s FAILING (%dx) — %s" % (key, rec["fails"], detail))
                    rec["alerted"] = True
                    rec["alerted_at"] = time.time()
                state[key] = rec

    if do_commit and not REPORT:
        state["_last_commit"] = time.time()
    if do_health and not REPORT:
        state["_last_health"] = time.time()

    # Roll the per-probe truth up into the four things the status page names. ONLY
    # the core probes: the deploy health lane answers "is this instance being kept
    # current", which is an operator's question, not a user's. A stale engine pin on
    # a site that serves, logs in and publishes perfectly is not an outage, and a
    # status page that calls it one is a status page people learn to disbelieve.
    components = {}
    for tname, probes in results.items():
        for probe, r in probes.items():
            if probe not in CORE_PROBES:
                continue
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
    if blocked:
        payload["path"] = {"cloudflare_unreachable": cut,
                           "since": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(path["since"]))}

    if REPORT:
        print(json.dumps(payload, indent=2))
        for p in problems + path_msgs:
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

    if blocked:
        log("PATH Cloudflare unreachable from here: %s (run %d, lanes muted)" % (", ".join(cut), path["runs"]))
    for line in problems:
        log("ALERT " + line)
    for line in recoveries:
        log("RECOVERED " + line)
    for line in path_msgs:
        log("PATH " + line.split("\n")[0])
        if cfg("PATH_NOTIFY", "yes").lower() not in ("no", "0", "false", "off"):
            notify(line)
    if problems:
        notify("Augur is broken:\n\n" + "\n".join(problems)
               + "\n\nSay so: bin/status set <component> outage \"...\"\n"
                 "https://andratwiro.github.io/augur-status/")
    if recoveries:
        notify("Augur recovered:\n\n" + "\n".join(recoveries))

    ok = all(r["ok"] is not False for probes in results.values() for r in probes.values())
    log("run %s%s%s" % ("ok" if ok else "PROBLEMS", " (+commit lane)" if do_commit else "",
                        " (Cloudflare blocked here, lanes muted)" if blocked else ""))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
