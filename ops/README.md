# Cloudflare notifications

Cloudflare will tell you your Workers are erroring, your Pages deploys are
failing, and that Cloudflare itself is having a bad day — but only per account,
and only if someone configured it. Augur runs on more than one account, so
"configured" is not a single act.

`cf-alerts.mjs` declares what every account should carry and creates what is
missing. It never deletes.

```sh
export CF_ACCOUNTS="hosted,delta"
export CF_HOSTED_TOKEN=…  CF_HOSTED_ACCOUNT=…  CF_HOSTED_EMAIL=you@example.com
export CF_DELTA_TOKEN=…   CF_DELTA_ACCOUNT=…   CF_DELTA_EMAIL=you@example.com

node ops/cf-alerts.mjs            # what exists vs what should
node ops/cf-alerts.mjs --apply    # create the difference
```

## What it configures

| Policy | Fires when |
|---|---|
| Workers errors | a Workers Observability alert rule trips — error rate, invocation failures — and again when it clears |
| Pages deployment failures | a deploy fails, so the worker or the chrome did not ship |
| Cloudflare is having an incident | major or critical, on Cloudflare's own status feed |

The first one is the delivery half of an error-rate alert. The threshold half
lives in **Workers Observability → Alerts** in the dashboard, where you say what
counts as too many errors on which worker. A notification policy with no
observability rule behind it is a phone that never rings; a rule with no policy
is an alarm in an empty room. Both halves, per account.

## The permission this needs

Reading policies needs nothing special. **Creating** one needs
**Account · Notifications · Edit**, and a token without it fails the POST with a
bare `10000 Authentication error` while every GET keeps working — which reads
exactly like a bug in the script. It is not, and the script says so by name
rather than reporting a partial success as a success. Creating the observability
*rules* additionally needs **Account · Workers Observability · Edit**.

Add both rows in the Cloudflare dashboard: My Profile → API Tokens → edit the
token → add the permission → Continue → Save. Then re-run with `--apply`.

## Where alerts can go

On a free plan the only eligible destination is **email**. Webhooks and PagerDuty
need a paid plan, so there is no direct push channel from Cloudflare to a phone
— the mail has to land in an inbox with notifications turned on, or the
Cloudflare mobile app has to be installed and signed in to that account.

This is also why the synthetic probes in `../probes/` are not redundant with
these alerts. Cloudflare's notifications are the platform telling you about
itself; the probes are somebody else checking, from somewhere else, with a
channel Cloudflare does not own.
