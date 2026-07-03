# Cold-outreach deliverability — one-time DNS setup

The single biggest lever for landing in the inbox (not spam) is **domain
authentication**. As of the 2024 Gmail/Yahoo bulk-sender rules, a sending domain
needs **SPF**, **DKIM**, and **DMARC** or its mail gets junked or bounced.

The outreach engine now checks this automatically (`utils/dnsAuth.js`), shows a
red/amber/green **Sender authentication** badge in the Studio's Outreach tab, and
**holds all cold sends** while the essentials (SPF + DMARC) are missing — the same
"don't send blind" guard it already applies when `OUTREACH_EMAIL_FROM` is unset.
Set `OUTREACH_DMARC_GATE=off` to make the check advisory-only.

> Do this once for the domain in `OUTREACH_EMAIL_FROM`. Use a **dedicated
> sending domain or subdomain** (e.g. `getjointprinting.com` or
> `mail.jointprinting.com`) so cold volume can never dent the reputation of the
> root brand domain.

## 1. SPF — authorize your SMTP provider

Add ONE `TXT` record at the domain root that includes your provider (SendPulse):

| Type | Host | Value |
| ---- | ---- | ----- |
| TXT  | `@`  | `v=spf1 include:sendpulse.com ~all` |

- Only **one** `v=spf1` record per domain — if you already have one, merge the
  `include:` in rather than adding a second.
- Confirm your provider's exact `include:` in their SPF docs.

## 2. DKIM — sign your mail

SendPulse (and most providers) give you **two CNAME records** to publish. In
SendPulse: *Settings → SMTP → DKIM/SPF* → copy the records:

| Type  | Host (example)            | Value (example)                     |
| ----- | ------------------------- | ----------------------------------- |
| CNAME | `s1._domainkey`           | `s1.dkim.sendpulse.com`             |
| CNAME | `s2._domainkey`           | `s2.dkim.sendpulse.com`             |

- The selector (`s1`, `default`, etc.) varies by provider. If ours isn't in the
  common list the checker probes, set `OUTREACH_DKIM_SELECTOR=<selector>` so the
  badge can find it.

## 3. DMARC — publish a policy

Add a `TXT` record at `_dmarc`. **Start at `p=none`** (monitor only, safe), then
tighten to `quarantine` once reports look clean:

| Type | Host     | Value |
| ---- | -------- | ----- |
| TXT  | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@jointprinting.com; fo=1` |

- `p=none` already satisfies the Gmail/Yahoo "must have DMARC" requirement (badge
  goes **amber**). Move to `p=quarantine` once you've confirmed SPF+DKIM pass, to
  reach **green**.
- `rua=` collects aggregate reports so you can see what's authenticating.

## 4. Custom Return-Path (bounce alignment) — optional but recommended

Point the envelope-from (Return-Path) at your domain so bounces align and are
captured. In SendPulse this is the "custom return-path" / bounce-domain CNAME they
provide. Wire the provider's **bounce webhook** to
`POST /api/outreach/bounce?key=$OUTREACH_BOUNCE_SECRET` so hard bounces and
complaints auto-suppress.

## Ramp & pacing (already automatic)

- The engine warms up: **10/day** the first week, doubling weekly to
  `OUTREACH_DAILY_CAP` (default **50** — a safe ceiling for one inbox). Raise it
  only after a few clean weeks.
- Sends are paced with per-send jitter, a per-domain daily cap, business-hours-only
  windows, and follow-up threading — all on by default.

## Quick check

Badge red? The Studio lists exactly what's missing. From a shell you can verify:

```
dig +short TXT jointprinting.com          # expect a v=spf1 line
dig +short TXT _dmarc.jointprinting.com   # expect v=DMARC1
dig +short CNAME s1._domainkey.jointprinting.com
```

## Relevant env

| Var | Purpose |
| --- | ------- |
| `OUTREACH_EMAIL_FROM` | The dedicated cold-sending identity (required to send). |
| `OUTREACH_DKIM_SELECTOR` | Override if your DKIM selector isn't auto-detected. |
| `OUTREACH_DMARC_GATE` | `off` to make the auth check advisory instead of a hard hold. |
| `OUTREACH_BOUNCE_SECRET` | Enables the provider bounce/complaint webhook. |
| `OUTREACH_SENDER_NAME` | Name the emails sign off as (`{{senderName}}`). |
