#!/usr/bin/env python3
"""Watch the support inbox and put it on the maintainer's phone.

A published response time is only worth the notification behind it. A solo
maintainer who has to remember to open a second mailbox will, eventually, not.

    inbox-watch.py              poll; ping on new mail, nudge on stale mail
    inbox-watch.py --report     print what it sees, send nothing
    inbox-watch.py --test-alert prove the channel

Two things it says:

  new mail     A message arrived that this watcher has not seen before. Sent
               once per message, with sender and subject, so triage can happen
               from the lock screen.

  going stale  Something unread has been sitting there longer than
               INBOX_STALE_HOURS. Repeated at most once a day. This is the one
               that keeps a two-business-day promise from quietly becoming a
               two-week one.

Config lives in the same file as the probes (/etc/augur-probes.env):

    INBOX_IMAP_HOST=imap.example.com
    INBOX_IMAP_USER=hi@example.com
    INBOX_IMAP_PASS=…
    INBOX_STALE_HOURS=24
"""

import email
import imaplib
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from email.header import decode_header, make_header

CONF = os.environ.get("AUGUR_PROBE_CONF", "/etc/augur-probes.env")
STATE_DIR = os.environ.get("AUGUR_PROBE_STATE", "/var/lib/augur-probes")
STATE_FILE = os.path.join(STATE_DIR, "inbox.json")
UA = "augur-inbox-watch/1"

REPORT = "--report" in sys.argv


def load_conf(path):
    conf = {}
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    conf[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    conf.update({k: v for k, v in os.environ.items() if k.startswith(("INBOX_", "TG_", "NTFY_"))})
    return conf


C = load_conf(CONF)


def notify(text):
    tok, chat = C.get("TG_BOT_TOKEN"), C.get("TG_CHAT_ID")
    if REPORT:
        print("WOULD SEND:", text)
        return
    if tok and chat:
        try:
            urllib.request.urlopen(urllib.request.Request(
                "https://api.telegram.org/bot%s/sendMessage" % tok,
                data=urllib.parse.urlencode({"chat_id": chat, "text": text}).encode(),
                headers={"User-Agent": UA}), timeout=15)
        except Exception as e:
            print("telegram send failed: %s" % e)
    if C.get("NTFY_URL"):
        try:
            urllib.request.urlopen(urllib.request.Request(
                C["NTFY_URL"], data=text.encode(),
                headers={"User-Agent": UA, "Title": "Augur support"}), timeout=15)
        except Exception as e:
            print("ntfy send failed: %s" % e)


def hdr(msg, key):
    v = msg.get(key)
    if not v:
        return ""
    try:
        return str(make_header(decode_header(v)))
    except Exception:
        return v


def main():
    if "--test-alert" in sys.argv:
        notify("Augur support inbox watcher: test message. The channel works.")
        print("sent")
        return 0

    host, user, pw = C.get("INBOX_IMAP_HOST"), C.get("INBOX_IMAP_USER"), C.get("INBOX_IMAP_PASS")
    if not (host and user and pw):
        print("no INBOX_IMAP_* configured — nothing to watch")
        return 0
    stale_hours = float(C.get("INBOX_STALE_HOURS", "24") or 24)

    state = {"seen": [], "stale_notified": 0}
    try:
        with open(STATE_FILE) as fh:
            state.update(json.load(fh))
    except Exception:
        pass
    seen = set(state.get("seen", []))

    m = imaplib.IMAP4_SSL(host, 993)
    try:
        m.login(user, pw)
        m.select("INBOX")
        # UIDs, not sequence numbers — sequence numbers shuffle when mail is filed.
        typ, data = m.uid("SEARCH", None, "ALL")
        uids = data[0].split() if data and data[0] else []
        fresh, oldest_unread = [], None
        for uid in uids:
            u = uid.decode()
            typ, d = m.uid("FETCH", uid,
                           "(FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT TO)])")
            if not d or not isinstance(d[0], tuple):
                continue
            meta = d[0][0].decode("utf-8", "replace")
            msg = email.message_from_bytes(d[0][1])
            unread = "\\Seen" not in meta
            when = imaplib.Internaldate2tuple(d[0][0])
            age_h = (time.time() - time.mktime(when)) / 3600 if when else 0
            item = {"uid": u, "from": hdr(msg, "From"), "to": hdr(msg, "To"),
                    "subject": hdr(msg, "Subject"), "age_h": round(age_h, 1), "unread": unread}
            if u not in seen:
                fresh.append(item)
            if unread and (oldest_unread is None or age_h > oldest_unread["age_h"]):
                oldest_unread = item
    finally:
        try:
            m.logout()
        except Exception:
            pass

    if REPORT:
        print(json.dumps({"messages": len(uids), "new": fresh, "oldest_unread": oldest_unread}, indent=2))

    for item in fresh:
        notify("Augur support mail\n\nFrom: %s\nTo: %s\nSubject: %s"
               % (item["from"], item["to"], item["subject"] or "(no subject)"))

    now = time.time()
    if (oldest_unread and oldest_unread["age_h"] >= stale_hours
            and now - state.get("stale_notified", 0) > 86400):
        notify("Augur support mail is going stale\n\n%.0f hours unanswered: %s — %s\n\n"
               "The published promise is a human reply within two business days."
               % (oldest_unread["age_h"], oldest_unread["from"], oldest_unread["subject"]))
        state["stale_notified"] = now

    if not REPORT:
        os.makedirs(STATE_DIR, exist_ok=True)
        # Keep the tail only: UIDs are monotonic, so old ones can never come back.
        state["seen"] = sorted(seen | {i["uid"] for i in fresh}, key=lambda s: int(s))[-500:]
        with open(STATE_FILE, "w") as fh:
            json.dump(state, fh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
