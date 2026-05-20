# JPW Spider Sheet Setup

How to wire the **"Push to Spider"** button so leads flow from the Lead Recon
tool into your Spider Google Sheet on a brand-new tab (separate from your
existing Subscriptions / Prospect Tracking / cold-call lists).

You do this once. ~3 minutes.

## 1. Add the Apps Script to the Spider sheet

1. Open the **Spider** Google Sheet.
2. **Extensions → Apps Script**. A new editor tab opens.
3. Delete whatever boilerplate is in `Code.gs`.
4. Paste the entire script from `apps-script/JpwSpiderEndpoint.gs` in this repo.
5. Near the top, change `SHARED_SECRET` to a long random string of your choosing
   (e.g. open a terminal and run `openssl rand -hex 32`, paste the output).
   **Save this secret** — you'll give it to the backend env in step 3.
6. Click **Deploy → New deployment**.
   - Type: **Web app**
   - Description: "JPW Recon push"
   - Execute as: **Me (your@email)**
   - Who has access: **Anyone with the link** (Google requires this for the
     backend to POST without OAuth; the secret is what actually protects it).
7. Click **Deploy**. Authorize when prompted.
8. Copy the **Web app URL** that appears (looks like
   `https://script.google.com/macros/s/AKfy.../exec`).

The script will create a tab named **`JPW Recon`** the first time a row is
pushed; it won't touch your other tabs.

## 2. (Optional) Test the webhook manually

```bash
curl -X POST 'YOUR_WEB_APP_URL' \
  -H 'Content-Type: application/json' \
  -d '{
    "secret": "YOUR_SHARED_SECRET",
    "target_tab": "JPW Recon",
    "rows": [{
      "business_name": "Test Co",
      "phone": "(609) 555-1234",
      "dedupe_key": "test:1"
    }]
  }'
```

You should see `{"ok":true,"results":[{"dedupe_key":"test:1","row":2,"status":"appended"}]}`
and a row in the new "JPW Recon" tab of Spider.

Delete the test row from the sheet when done.

## 3. Set backend env vars

On Render (or wherever the backend runs), add these env vars:

| Key | Value |
| :-- | :-- |
| `JPW_SPIDER_WEBHOOK_URL` | the Web app URL from step 1.8 |
| `JPW_SPIDER_SHARED_SECRET` | the secret from step 1.5 |
| `JPW_SPIDER_TAB` | *(optional)* `JPW Recon` (the default, only set this if you want a different tab name) |

Redeploy the backend so it picks up the new env vars. After redeploy the
"Push to Spider" buttons in the Lead Recon tab will activate.

## 4. How dedupe works

The backend sends a `dedupe_key` with every row. The Apps Script keeps a
hidden column with that key and refuses to re-append a row whose key is
already present. If you push the same lead twice, the second push is a
no-op (status `"already_present"`).

Dedupe key priority:
1. `place:<google_place_id>` if known
2. `phone:<normalized-10-digit>`
3. `domain:<apex>`
4. `name:<normalized-name>|<normalized-city>`
5. `id:<mongo-id>` (fallback)

If you want a lead re-pushed with updated data, delete its row from the
sheet first.

## 5. Re-deploying after Apps Script changes

If the Apps Script file in this repo (`apps-script/JpwSpiderEndpoint.gs`)
changes — e.g. when the backend adds new features like the cross-tab phone
dedupe — you need to re-deploy your copy of the script in Spider for the new
behavior to take effect.

1. Open Spider → **Extensions → Apps Script**
2. Replace the contents of `Code.gs` with the latest version from this repo
   (keep your `SHARED_SECRET` value — don't paste over it with the placeholder)
3. **Deploy → Manage deployments → pencil-edit the existing deployment →
   Version: New version → Deploy.**
   The Web app URL stays the same, so no backend env update is needed.

## 6. Rotating the secret

Change `SHARED_SECRET` in the Apps Script + the backend env var to the same
new value, save+deploy the script, redeploy the backend. The old secret stops
working immediately.
