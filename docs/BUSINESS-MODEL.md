# Joint Printing — Business Model & Operating Map

> What the business *is*, commercially — who pays, what's sold, how money is made, and
> which tools/integrations run it. Companion to `docs/ECOSYSTEM.md` (the canonical order
> flow + owner decisions); this doc doesn't repeat that spine, it sits around it.
> Compiled from a full-code scan of both repos (July 2026), plus the owner's direct
> answers under **Owner answers** at the bottom — update that section as facts change.

---

## The business at a glance

- **Joint Printing LLC** — custom merch / screen-printing / embroidery / promo-products
  studio. Owner-operated by **Nate** (nate@jointprinting.com — the only email identity
  that exists; (856) 899-7642), based in New Jersey, fully remote. Positioning: *"We're
  your merch department, not just a printer."*
- **Full-time business.** Roughly **$75k revenue to date**; **12-month target: $150k**
  (owner, July 2026).
- **Broker/decorator model, no in-house printing.** Blanks sourced from wholesale
  suppliers (**SanMar**, **S&S Activewear**); decoration outsourced to a network of
  **~16 printers/vendors** (rebuilt from the owner's Google Drive PO history); JP owns
  the client relationship, design/mockups, quoting, and fulfillment coordination.
- **Primary vertical: cannabis** — dispensaries first (dedicated catalogs "JP ×
  Dispensary", "Dispensary Promos"), then breweries, startups, restaurants, events,
  gyms, nonprofits, retail. Customer base skews small cannabis brands.
- **Second business in the same codebase: JP Webworks (JPW)** — web-design/marketing
  lead-gen for South Jersey service businesses (Lead Recon, Cold Call Tree, "Spider"
  Google Sheet). **Paused** — owner: it returns only as a **side project for simple
  website creation, nothing more**. Treat the JPW tooling as legacy; don't invest in it.

## How money is made

- **Quote pricing:** per-unit price = `(blankCost + printCost + (setup+shipping)/qty) ×
  markup`, default **markup 1.4 (+40%)**; markup tiers selectable 5%–70%
  (`models/Order.js`, `QuoteBuilder.js`). Public site shows teaser prices at
  `max($5, blankCost × 1.4)` (`utils/pricing.js`).
- **MOQ & turnaround (public promises):** sweet spot **50+ units/design**; **~3–4 week**
  turnaround from approved mockup + payment; free mockups (~3-day turnaround), no
  commitment. Internal alerting is stricter: **2 weeks = "running long", 3 weeks =
  "possibly late"** (`/api/orders/attention`).
- **Payment:** owner invoices manually via **QuickBooks** after client approval (no
  auto-charge, by explicit decision). Processing fees auto-booked as COGS:
  **CC 2.99% / ACH 1%** (`PAYMENT_FEES`, mirrored frontend/backend). Payment method is
  asked per sale, never defaulted per client.
- **Sales tax:** per-ship-to-location, merchandise only. Rates (mirror of
  `STATE_TAX_RATES`): NJ 6.625, NY 8, CT 6.35, MA 6.25, VT 6, PA 6.
- **Printer routing strategy (owner's words, manual today):** pick the printer
  **closest to the client but NOT in the client's state** — minimize print+ship cost
  while avoiding creating a **sales-tax nexus**. Fields exist on Vendor
  (city/state/capabilities/leadTime/quality); nothing routes automatically yet, by
  design.
- **Per-order margin:** signed `Client Sales` revenue − COGS categories
  (`Blank COGS, Printer COGS, Shipping, Art, Commission, Processing Fee`). Owner
  Draw/Contribution are equity, excluded from P&L profit.
- **Margin reality (owner, July 2026):** there is **no hard floor** — he has taken
  **$0-profit orders purely to land a client**; a typical order nets around **$200
  profit**. The +40% default markup is a starting point, not a rule.
- **Scale reference:** the verified 2024–2026 budget-tracker import ties out to
  **net cash $22,413.41 across 330 ledger rows** (`scripts/buildFinanceSeed.js`);
  marketing claims "30,000+ units delivered".

## How customers arrive (funnel)

Acquisition channels, all feeding the CRM (`companyKey` spine):

1. **Website lead forms** → `/api/email/send-contact` (contact page + product "quote
   tray") → Studio Inquiries + owner email + customer auto-reply with **WELCOME10**
   (10% off first order, ≤$100, manual honor-system code).
2. **Calendly** — "free 15-min call" (`calendly.com/nate-jointprinting/30min`), the
   dominant public CTA.
3. **Referrals** — "$100+ per referral" credit (manual), `/contact?topic=referral`.
4. **Cold email — the Outreach engine** (`services/outreachEngine.js`): campaign
   sequences (default 3-touch: intro → free-mockup hook → breakup) sent from a
   **separate sending identity** (`OUTREACH_EMAIL_FROM`, never the main domain),
   Mon–Fri 9–5 ET, **doubling warm-up ramp 10→20→40→80… capped at
   `OUTREACH_DAILY_CAP` (default 150/day)**, CAN-SPAM footer + unsubscribe + open
   tracking, MX verification, bounce suppression. Every send logs a CRM touch and
   nudges stage lead→contacted.
5. **Free lead finder** (`services/dispensaryFinder.js` + `leadFinderScheduler.js`):
   $0 dispensary discovery via **OpenStreetMap Overpass** (deliberately not Google
   Places — zero lead-spend policy), region-by-region national rollout **NJ-first**,
   self-advancing weekly frontier (NJ → NY → PA → … → CA → WA, wraps) once the owner
   flips auto-pilot on. Scrapes dispensary websites for missing emails.
6. **In-person sweeps — Field Map** (`RoadTripTab`): nationwide dispensary pins,
   Today's Run, one-tap capture into the CRM.
7. **Site intelligence:** Microsoft Clarity on every public page (disclosed in the
   Privacy policy). Apollo.io was removed July 2026 — the owner never used it.

**What actually works (owner, July 2026):** deals are won by **road visits and cold
email**; **most revenue comes from dispensaries**; the binding constraint is **quality
lead volume** (not quoting time, cash, printer capacity, or hours). Reorders are "not a
lot but a good amount" of revenue. Nothing meaningful lives off-app besides QuickBooks
invoicing, which doesn't hurt. Seasonality (4/20, holidays, USA-250th) is handled with
marketing pushes, not tooling.

**CRM stages** (post-July-2026: "sampling" retired, boot-migrated to quoting):
`lead → contacted → quoting → won / customer`, closed: `lost, dormant`. Close
probabilities: lead .10, contacted .25, quoting .50, won/customer 1. Pipeline is
order-centric (one client → many order cards): board columns
`lead, contacted, quoting, approval (.8), production (.9), shipped (.95), delivered (1)`.
**Customer status is permanent** (stage can never regress below customer; auto-promoted
on first placed order).

## The operating system (tools map)

Private Studio (`/studio`, React) over the Express/Mongo API. One line each — the deep
map lives in the code and `docs/ECOSYSTEM.md`:

| Tool | Job |
|---|---|
| **CRM** | Book of companies, Today call queue, order-centric pipeline, calendar, dashboard |
| **Order Tracker** | Quote → confirmation → client approval link → POs → tracking → delivery; "next action" engine |
| **Outreach** | Cold-email campaigns, enrollments, send queue, analytics, lead auto-finder |
| **Field Map** | Nationwide dispensary map, run planning, CRM capture |
| **Printers · Vendors** | Vendor cards, POs, lifetime spend, per-vendor PO numbering |
| **Finances** | Year ledger, P&L, per-order margin, payment gaps, missing receipts, CSV import/export |
| **Receipts** | Upload → **Claude Haiku** AI extraction (~½¢/receipt) → review → booked transaction |
| **Mockup Studio** | Separate vanilla-JS canvas app (`/jpstudio/`), mockup #s linked to projects |
| **Inquiries** | Website form submissions mini-CRM |
| **Catalogs** | Curated product picks + PDF catalog management |
| **Backup** | Full-site snapshot download/restore + weekly Google Drive off-site push |
| *(paused)* Lead Recon / Cold Call Tree | JP Webworks lead-gen |

**The client-facing approval flow is the crown jewel:** token link → client picks
brand/options + payment method → approves ("approval is final") → link becomes a live
tracking timeline. Invoice # assigned on approval (continues the QuickBooks sequence).

**Automations (crons, single Render dyno):** S&S price/size sync 02:00 daily · JPW
rescore 03:00 daily + Sunday re-audits (paused business, cheap) · Google Drive backup
Sunday 03:30 · Outreach sender every 15 min inside the send window · weekly lead-finder
frontier sweep (opt-in). Receipt scanner resumes interrupted reads on boot.

## Infrastructure & accounts

- **Vercel** — frontend hosting; merge to `main` = production deploy (jointprinting.com).
- **Render** — API host (`jointprinting-backend.onrender.com`); cold starts are real
  (static catalog PDFs are committed to the frontend repo as a fallback).
- **MongoDB Atlas M0 (free, 512 MB)** — the size ceiling drives design: images live as
  S&S CDN URLs or in **Cloudflare R2**, not in Mongo.
- **SMTP** (SendPulse/Gmail via env) for transactional mail; **separate cold-outreach
  sending identity** required by the engine.
- **Anthropic API** (Claude Haiku) for receipt extraction — feature-flagged; without a
  key receipts park as `pending`.
- **Google**: Drive (backups, OAuth), Places API (JPW only, budget-capped), Apps Script
  (JPW "Spider" sheet endpoint).
- **QuickBooks/Intuit** — invoicing, manual (Terms/Privacy pages exist for the Intuit
  Developer app submission). Surcharges disclosed: CC 2.99% / ACH 1% / Venmo 1.9%+$0.10.
- **Mapbox** (Field Map), **OpenStreetMap Overpass** (free lead finding), **S&S
  Activewear API** (catalog; SanMar has no API integration), **Calendly**, **Apollo.io**,
  **Microsoft Clarity**, Instagram `@jointprinting`, LinkedIn.

## House principles (encoded, don't violate)

- **One connected organism**: every fact has one home, joined on `companyKey` +
  `projectNumber`; deep-link everything; surface the next action unprompted.
- **The dev sandbox cannot write the production DB** — live-data changes ship as
  in-app preview→confirm tools: idempotent, reversible, archive-not-delete, auto-hiding.
- Shared constants are mirrored frontend/backend with "MUST match" comments and sync
  tests (`_crm.sync.test.js`, `_shared.confTax.test.js`) — change both sides together.
- Committed seed data is real business data; acceptable only while repos are private.

## Known issues & opportunity backlog (from the July 2026 code scan)

Owner-flagged: **Vendors/POs** (hard-delete PO, duplicate PO numbers possible,
free-text vendor identity, `blanksProvided` default drift) and **CRM interaction
depth** (no multi-select/marquee, calendar drag) — details in `docs/ECOSYSTEM.md`.

Additional findings worth a pass:

- **Stock photography** on About/heroes (Unsplash/Midjourney) — partially replaced with
  owner uploads (#277); the rest awaits real product shots.
- **Modeled-but-unbuilt** (deliberate, plans on file): printer pricing matrix, geo/nexus
  routing, mockup-round history, closeout/QA step, Lookbook rebuild.

Resolved July 2026: privacy page now discloses Clarity; Apollo tracker removed
(unused); `/customize` redirects to `/contact`; legal pages use `nate@`; PWA manifest
branded; dead marketing components deleted.

---

## Owner answers — July 2026 (the facts code can't reveal)

Captured from Nate; treat as ground truth until he updates them.

1. **Goals & scale:** full-time; ~**$75k revenue to date**, **$150k** 12-month target.
   JP Webworks returns only as a side project doing simple website creation — nothing
   more; treat its tooling as legacy.
2. **Margins:** apparel and promos both; **no floor** — has done **$0-profit orders to
   win a client**; typical order nets **~$200**.
3. **Customer mix:** most revenue is **dispensaries**.
4. **Winning channels:** **road visits + cold email** close deals.
5. **Bottleneck:** **quality lead volume** — not time, cash, or capacity.
6. **Reorders:** "not a lot but a good amount."
7. **Off-app work:** nothing painful (QuickBooks invoicing is fine as-is).
8. **Seasonality:** real (4/20, holidays, USA-250th) but handled by making new
   marketing, not by tooling.
9. **Email:** `nate@jointprinting.com` is the only address that exists.
10. **Tracking:** keep Clarity, Apollo removed (never used).

**Implication for future work:** the highest-leverage direction is anything that
increases *quality* dispensary lead flow into road-visit and cold-email motions (and
conversion of them) — not internal-ops automation, which the owner says doesn't hurt.
