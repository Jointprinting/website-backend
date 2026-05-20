# JP Webworks Lead Recon

Lead-prospecting engine that lives inside the password-protected `/studio` admin.

Login at `/studio` → click **JP Webworks → Lead Recon**.

## What it does, end-to-end

1. **Discover** local service businesses, by:
   - Pasting an Apify / OutScraper / Maps scraper export (CSV or JSON)
   - Running a Google Places search (category × town/county) — uses the
     existing `GOOGLE_PLACES_KEY`
   - Manually adding a single lead
2. **Dedupe** every incoming row against existing leads by Google place_id →
   normalized phone → apex domain → fuzzy name+city match.
3. **Audit** each lead's website. One HTTP request, parses the HTML, fills in
   18 signals (SSL, mobile viewport, title/meta/H1, click-to-call,
   contact form, quote CTA, services, service-area towns, reviews on site,
   gallery, map embed, LocalBusiness schema, copyright year, tracking pixels,
   landing-page structure, CMS sniff).
4. **Score** the lead on a 100-pt formula (Buying Intent 30 + Pain 25 + Ability
   to Pay 25 + Fit 15 + Urgency 5, minus penalties), assigns a grade A+→D,
   recommends one of the four JPW offers, and writes a one-line opener.
5. **Surface** A+/A leads in a Call Queue with one-click status buttons
   (Called / Voicemail / Interested / Booked / Follow Up / Not Fit / DNC).
6. **Push** qualified leads to your Spider Google Sheet (separate "JPW Recon"
   tab so it doesn't mix with the existing tabs).

## Environment variables

| Var | What it's for | Required for |
| :-- | :-- | :-- |
| `GOOGLE_PLACES_KEY` | Google Places (New) Text Search | Places search button |
| `JPW_PLACES_DAILY_CAP` | Cap on Places API calls per day | Optional, default 200 |
| `JPW_SPIDER_WEBHOOK_URL` | Apps Script Web app URL | "Push to Spider" buttons |
| `JPW_SPIDER_SHARED_SECRET` | Shared secret for the webhook | "Push to Spider" buttons |
| `JPW_SPIDER_TAB` | Spider tab name | Optional, default "JPW Recon" |

`GOOGLE_PLACES_KEY` is already set on Render (the RoadTrip tool uses it too).
The Spider vars are new — wiring instructions in `docs/JPW_SPIDER_SETUP.md`.

## API surface (all admin-only behind `requireAdmin`)

| Route | Purpose |
| :-- | :-- |
| `GET    /api/jpw/leads` | List leads with filters (grade, status, category, county, etc.) |
| `POST   /api/jpw/leads` | Create or upsert one lead |
| `GET    /api/jpw/leads/:id` | Get one |
| `PUT    /api/jpw/leads/:id` | Update one |
| `DELETE /api/jpw/leads/:id` | Delete one |
| `POST   /api/jpw/leads/:id/audit` | Run the website auditor |
| `POST   /api/jpw/leads/:id/push-to-spider` | Push one lead to the Spider sheet |
| `POST   /api/jpw/leads/:id/ad-signal` | Save Meta Ad Library notes for one lead |
| `POST   /api/jpw/import` | Bulk import (JSON / CSV with header row) |
| `POST   /api/jpw/search/places` | Run a Google Places Text Search → ingest |
| `POST   /api/jpw/audit-batch` | Audit N leads (filters: ids / only_unaudited / by grade) |
| `POST   /api/jpw/push-to-spider-batch` | Push N leads (defaults to A+/A unpushed) |
| `POST   /api/jpw/rescore` | Re-run scoring on all (or filtered) leads |
| `POST   /api/jpw/bulk-status` | Set call_status on many leads in one call |
| `GET    /api/jpw/stats` | Dashboard counts |
| `GET    /api/jpw/usage` | API usage today + cap + config flags |
| `GET    /api/jpw/reference` | Towns / counties / categories / score caps |
| `GET    /api/jpw/export.csv` | CSV in Spider column order |

## Data model

- `JpwLead` — one document per business; contains identity + dedupe keys +
  Google signals + `website_audit` subdoc + `ad_signal` subdoc + `lead_score`
  subdoc + call-queue state + Spider push state.
- `JpwApiUsage` — one document per calendar day; counts Places calls + audits.

## Tests

Unit tests for scoring, dedupe, constants, and the auditor's HTML-parsing
layer (offline, stubbed axios). Run with:

```bash
cd website-backend
node --test services/__tests__/*.test.js
```

Current count: **22/22 passing**.
