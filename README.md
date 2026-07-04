# website-backend

Express + MongoDB/Mongoose API behind [jointprinting.com](https://jointprinting.com).
The private Studio at `/studio` in `website-frontend` is this API's main client.

## Run

```bash
npm install
cp .env.example .env      # then fill in the values (see below)
npm start                 # boots server.js on $PORT (default 8080)
npm test                  # node --test suites in controllers/__tests__ + services/__tests__
```

## Layout

`server.js` (entry) · `controllers/` (HTTP handlers) · `models/` (Mongoose schemas) ·
`routes/` (wiring) · `services/` (integrations / business logic) · `middleware/`
(cross-cutting) · `utils/` (helpers) · `scripts/` (one-off maintenance/migrations) ·
`apps-script/`.

## Environment

Copy `.env.example` → `.env` and fill it in — it documents **every** variable the
app reads, grouped by subsystem, with defaults and which are required. The
essentials to boot:

| Variable | Required | What it does |
| --- | --- | --- |
| `MONGO_URI` | ✅ | MongoDB connection string. **The database named in the URI is also where GridFS images are stored** — point it at the real db, not `test`. |
| `JWT_SECRET` | ✅ | Signs Studio session tokens. |
| `STUDIO_NEW_PASSWORD` | ✅ | The `/studio` admin login password. |
| `PORT` | | HTTP port (default `8080`). |
| `ALLOWED_ORIGINS` | | Comma-separated CORS allow-list. |
| `OUTREACH_EMAIL_FROM` + SMTP creds | for outreach | Sending identity for the cold-outreach mail-merge engine (own the domain + set SPF/DKIM/DMARC). |
| `SS_ACCOUNT` / `SS_API_KEY` | for catalog | S&S Activewear product proxy. |
| `GMAIL_*` | for reply triage | Live Gmail reply ingest (`GMAIL_TRIAGE_ENABLED=true`). |
| `MAPBOX_TOKEN` | for the Field Map | Dispensary map tiles. |
| `ANTHROPIC_API_KEY` | for receipts | Receipt OCR / parsing. |

The full grouped list (Studio auth, the whole `OUTREACH_*` engine, `LEAD_FINDER_*`
tuning, Google/Drive, JPW spider, data-import scripts) lives in **`.env.example`**.

## Docs

- `docs/BUSINESS-MODEL.md` — who pays, how money is made, the funnel, integrations.
- `docs/ECOSYSTEM.md` — the canonical order flow + owner decisions.
