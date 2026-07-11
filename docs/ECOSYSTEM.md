# Joint Printing — The Living Ecosystem & Canonical Order Flow

> Source of truth for how the business actually runs and how the app should remember it.
> Captured from the owner (Nate). Future work should treat this as the spine the whole
> system hangs off. The north star: **one connected organism** — every record deep-links
> to everything it touches, keyed by a canonical **`companyKey`** and **project #**; the
> same fact never lives in two places out of sync; the app surfaces the next action
> before he asks.

---

## The canonical order flow (how a job really moves)

This is the owner's real, end-to-end process. Every step should leave **connected,
queryable data** hung off the one project # + companyKey — nothing re-typed, nothing
forgotten.

1. **Find the client** → ask what products they want, the designs, and the quantities.
2. **Find brands** → pull quotes from the **saved printer pricing matrix**, then set the
   client's pricing with the owner's **added margin**.
3. **Mockup studio** → make one or two **mockups with their logo** → show the client.
4. **Iterate** → the client often wants to see more brands or more mockups → repeat
   steps 2–3 as many rounds as it takes.
5. The client **picks a brand, quantity, and colors**.
6. The owner **sends a confirmation page**.
7. On **approval** → the owner **sends an invoice**.
8. On **payment** → the owner **orders the blanks from the printer** — *unless the printer
   supplies its own blanks* (e.g., the cannabis-promotions printer prints on its **own**
   lighters / ashtrays, so there are no blanks to buy).
9. The **printer prints and ships** to the client.
10. The owner **confirms everything went well** (closeout / QA).

---

## "The ecosystem remembers everything" (the data principle)

> *"I want all data saved like a living ecosystem remembers that — very important."* — Nate

Every step above must persist a connected artifact, all joined on **project #** (system
identity — the Mongo `_id` / project number, **never** the owner's unreliable manual
"budget order #") and **`companyKey`** (one record per real company). The intent, in
order:

| Step | What the ecosystem must remember | Joined to |
|------|----------------------------------|-----------|
| 1 | The products/designs/quantities asked for (the opening ask) | company → project |
| 2 | Every brand considered + its **matrix quote** + the **margin** applied | project |
| 3 | Each **mockup version** and **which logo** was used | project + client logo |
| 4 | Each **round** of "show me more" (brands/mockups), so the back-and-forth is history, not lost | project |
| 5 | The chosen **brand / quantity / colors** | project |
| 6 | The **confirmation** sent + when | project |
| 7 | **Approval** timestamp → **invoice** sent | project |
| 8 | **Payment** received → **blank order** to printer, **or** the *printer-supplies-blanks* flag | project + vendor/PO |
| 9 | **Print + ship + tracking** | project + vendor |
| 10 | **Closeout / QA** — "everything went well" | project |

The test for "genius": open any record (a company, a project, a printer, a receipt, a
mockup) and reach **everything it touches in one tap**; nothing dead-ends; and every
number ties out because each fact has exactly one home.

---

## Where each step lives today, and the gaps

A quick as-is map so future work knows what to connect (not a task list — a starting
point).

- **Steps 1, 5 (the ask / the pick):** CRM (`crm/CompaniesView`, `crm/CompanyDetail`) and
  the confirmation builder. **Gap:** the *opening* ask (products/designs/quantities) has no
  structured home — it only becomes data once a quote/confirmation exists. The pipeline is
  order-centric (one client → many order cards), which is right.
- **Step 2 (brands, matrix, margin):** `studio/QuoteBuilder`. **Gap:** the "saved printer
  pricing matrix" and the margin math should be first-class, reusable structured data, not
  re-entered per quote.
- **Step 3 (mockups):** the Mockup Studio is a **separate app launched via
  `window.open('/jpstudio/')`** from the hub. **Gap:** it's a one-way launch — a mockup
  built there has **no surfaced back-link** to the order/client it belongs to. `ClientLogo`
  exists; mockup versions are not tied into the project timeline.
- **Step 4 (iteration):** **Gap:** there's no structured record of the rounds — "showed 3
  brands, 2 mockups, they picked round 2" is not remembered anywhere.
- **Steps 6, 7, 9 (confirm → approve → track):** `studio/ConfirmationBuilder` →
  client-facing `ApprovalView` (share a link → client picks brand/options + payment method
  → owner approves → the link flips to a live **tracking timeline**). This flow is the
  strongest part of the ecosystem.
- **Step 8 (blanks / PO):** `studio/PoBuilderDialog`, `Vendor.blanksProvided` /
  `PurchaseOrder.blanksProvided`. The *printer-supplies-blanks* case is modeled by the
  `blanksProvided` flag — but see the Vendors-tab issues below (the two defaults can drift).
- **Step 10 (closeout/QA):** **Gap:** "everything went well" is not a modeled step — there's
  no closeout/QA state or checklist on a project.

---

## Flagged-weak surfaces (owner-flagged + audit-confirmed)

### Vendors / Purchase Orders — *"a lot of bugs, doesn't seem well made"* (owner-flagged)

A surface-by-surface audit confirmed it. Concrete issues to fix when this surface is
reworked:

**Real bugs / risks**
- **PO delete is a hard delete** (`deletePo → findByIdAndDelete`) behind a raw
  `window.confirm`, unlike every other record here which soft-archives. A fat-finger delete
  of a real PO is **unrecoverable** — jarring next to the carefully reversible Rebuild/merge
  tooling. Should soft-archive like the rest.
- **Dual-sourced, editable PO numbering:** the app auto-mints a per-vendor `#NNN`, but the
  PO # is also a free-text field the owner can overwrite, and the counter only bumps when
  the number changed. **Two POs for one printer can silently share `#007`** — no
  prevention or detection.
- **Vendor identity is matched by free-text name** (case-insensitive regex on `vendorName` /
  `Transaction.party`), not a stable id. A rename/typo ("Heritage" vs "Heritage Screen
  Printing") **orphans spend off the card** until a merge re-points it.
- **`blanksProvided` lives in two places with different defaults** (`Vendor.blanksProvided`
  defaults `true`; `PurchaseOrder.blanksProvided` defaults `false`). A PO created/edited
  outside the seed path, or a vendor toggle changed after POs exist, can leave them out of
  sync — directly relevant to step 8 of the order flow.
- **Two money figures on the vendor card can disagree with no reconciliation:** "PO total"
  (sum of PO `grandTotal`) vs "Lifetime spend" (signed sum of expense transactions matched
  by party name). An unpaid PO or a receipt under a slightly different party string makes
  them diverge silently.
- **Per-unit cost is parsed from free-text labels** (`parseUnitCost` regex on `"$x/unit"`),
  not stored structurally — edit the label wording and the displayed `/unit` figure changes
  or vanishes though the dollar amount didn't.
- **Capabilities/state are un-normalized strings** ("screen print" vs "screenprint" vs
  "Screen Print" are distinct) — any future capability filtering/routing will miss printers
  on spelling drift.

**Friction (Notion-grade interaction missing)**
- No **multi-select / drag-select / bulk actions** on the vendor list — to set
  state/lead-time/capabilities on the 16 rebuilt printers, he opens each card and edits
  field-by-field.
- The Network & routing block is a grid of **blank fields to hand-type**, one printer at a
  time (16 cards × ~6 fields after a Drive rebuild).
- **Capabilities is one comma-separated text field** — no chip multi-select, no autocomplete
  against tags already used elsewhere.
- **Every PO-builder outcome is a blocking `alert()`** (created/skipped/held/warnings) instead
  of inline, actionable rows.
- The **"generate POs from confirmation" held case dead-ends in prose** — it tells him to go
  assign suppliers on the confirmation items and re-run, but the PO builder can't set the
  per-item printer itself.
- **No "New PO" affordance on the Vendors tab or a printer's card**, and existing POs on a
  card are read-only — to edit a charge he must remember the order, go to the project, and
  open the PO builder there.
- **"Recent costs" copies one charge line at a time** — no "duplicate this whole PO" for a
  repeat job.

### CRM — owner-flagged as the weakest area

Notion-grade interaction is missing in places — e.g., the **Calendar can't click-drag to
multi-select** days/events (you click each one individually). The broader pattern, found
across surfaces: **no multi-select/bulk-action anywhere**, and several views dead-end
instead of deep-linking. (Full per-surface notes available from the surface-walk review.)

---

## Owner decisions — round 1 (CRM + identity)

Captured directly from Nate; treat as the spec for these areas.

- **Interaction:** true **drag rubber-band / marquee select** is wanted across lists (his words: "would be sweet").
- **Calendar reschedule:** **click-hold-drag a chip to any exact date** (Notion-style) — *not* "push to next week" presets. Land it on whatever date he wants (next week, two months out). Marquee-select yes; **range-select not needed**. Calendar is for **moving existing** follow-ups (not creating).
- **Overdue pileup:** one action to **push all overdue to the next business day**.
- **Follow-ups** live at the **company level** (not per-project). Keep the dialog that **sets the next follow-up in the same step**.
- **Companies bulk:** the common batch is **change follow-up date** or **delete**; stage changes happen **inside the card**.
- **Company card:** client/contact info should **not be the first thing shown** — it's backup reference to pull when needed; de-emphasize it. **Editing client fields happens only on the client card.** Show a company's **alternate names (akas)** on the card. There is **no "default printer/markup"** concept — don't build defaults.
- **Note delete:** brief (**~5s**) undo.
- **Pipeline:** deals move **one at a time** (multi-select drag is not a priority). **Inline-edit** deal value + follow-up date (double-click).
- **Deal value** is an estimate; when **real revenue lands, the card/order value should match the revenue**.
- **Customer status is permanent** — once a customer, always a customer (even if they go cold). **Lock the stage so it can't regress** to lead. No "became a customer" timeline event needed (it's just their first order).
- **Numbers / identity:**
  - Printer receipts often carry the **printer's own order number** — the **receipt scanner must be smart** about that and not mistake it for the project #.
  - The **invoice #** continues the sequence from QuickBooks; low priority but nice to track.
  - The client should **only ever see the mockup # and the project #**.
  - A **duplicate order number** should **warn + offer to merge**.
  - Old sibling-invoice orders (1023, 1041): don't dwell — store as best.
  - North star for the budget-#/identity mess: **"make the smartest possible ecosystem."**
- **Fix-data:** the historical budget-import unlinked receipts (133 of them) are **not worth chasing** — only **future hand-entered** mis-keys matter. (Detector now ignores budget/import/system-sourced rows.)

## Owner decisions — round 2 (payments, quoting, vendors, leads, identity, hub)

- **Payments on approval:** NO auto-charge. On approval, record the client's chosen
  method and tell them an **invoice email is coming shortly** — the owner builds the
  invoice in **QuickBooks** and sends it himself. (Shipped: the approval page now shows
  that notice.)
- **Payment method:** ask **per sale** — do NOT build a per-client default.
- **Receipts:** the owner attaches them **one at a time as he gets them** — do NOT build
  a receipts inbox/queue.
- **Sizes & pricing:** the size breakdown is entered **only at confirmation** (not at
  quote). Blank pricing is **averaged across all sizes** → **one price per item**; there
  is no per-size upcharge (e.g. no separate 2XL price).
- **Printer pricing matrix:** there are too many matrices to systematize — the owner
  **keeps quoting manually for now**. Leave matrix integration as a **future project**.
- **Printer routing = GEOGRAPHY, not product** (the owner's explicit strategy): pick the
  printer **closest to the client but NOT in the client's state**, to avoid creating a
  **sales-tax nexus** in the client's state. The aim is to minimize combined **print +
  shipping** cost. Do NOT auto-build routing/nexus logic yet — record the strategy; he
  picks manually today.
- **Field Map → dispensaries only:** remove campgrounds, parks, and coffee shops (and the
  multi-day sleep/route/GO-mode planning that depends on them). He wants a **better
  visit-logging** system that lives in the **CRM**: he starts a **project #** when a road
  deal reaches **quote** stage, then marks it **won/completed** when done. (Plan ready —
  see below.)
- **Company identity:** the canonical company is exactly its real name (e.g. "Happy Leaf
  Dispensary", nothing else). BUT a contact sometimes orders for a **different** company —
  so support an **order-level company name** (used as that order's title, linked to the
  ordering person). 99% of the time it's the same company; the override is for the
  occasional "ordering for another company" case.
- **Whole-client view:** show **total spend-with-us** and **total profit** per client.
- **Hub:** surface **to-dos** + **missing items** + **overdue orders**. Standard order
  turnaround is **2–3 weeks** → warn at **2 weeks** ("running long") and **3 weeks**
  ("possibly late").
- **Company card:** the contact/client info is **backup reference, not the headline** —
  tuck it (shipped: slimmed the header to name + stage, moved phone/email/address into the
  sidebar). Alternate names (akas): add tastefully once there's data to populate them.
- **Mockup studio:** **rebuild the Lookbook maker entirely** — genius, every aspect
  beautiful. (Plan ready — see below.)

## Big builds — plans on file

**Field Map (RoadTripTab) → dispensaries-only + CRM visit logging.** Remove the
coffee/parks/campgrounds layers, their backend search endpoints, and the entangled
sleep-stop / multi-day route planner + live GO-mode nav (all depend on the removed
layers). Keep dispensary search + the density heatmap. Then add: quick visit-outcome
capture on a pin (interested / not-now / notes + visited date), a pin→CRM `companyKey`
link, and a one-click **"Promote to CRM"** that finds-or-creates the company and starts a
quote-stage deal — so a road prospect flows straight into the pipeline. The
`RoadTripLead` model already has the needed fields (`companyKey`, `visitedAt`,
`visitOutcome`).

**Lookbook maker rebuild.** Today the mockup studio (`public/jpstudio/index.html`, a
4.5k-line vanilla-JS app) builds mockups and exports a lookbook PDF that **dead-ends on
the owner's device** — the client never sees it. Rebuild it so a **Lookbook is a
first-class, persisted, shareable artifact**: a `Lookbook` model (per project: ordered
mockups, layout, styling, status, share token), a React builder (search/pick mockups,
drag-reorder, live style, save draft, share link, export), and a **beautiful
client-facing gallery** wired into the approval flow (the lookbook becomes what the client
reviews). Open design questions for the owner before the full build: does the client
approve the whole lookbook vs per item; can they request changes/versions; the aesthetic
direction (minimal vs bold vs branded); and whether a lookbook is tied to one project or
standalone.

## Hard guardrails (carried from the handoff — do not violate)

- **The sandbox cannot write the production DB.** Any change to LIVE data ships as an in-app
  **preview → confirm** tool the owner runs himself: idempotent, reversible,
  **archive-not-delete**, auto-hides when there's nothing to do. Templates:
  `controllers/dataCleanup` + `DataCleanupView`, `services/financeDedupe`,
  `services/crmReconcile` — persist the snapshot **before** mutating.
  - **Owner-approved exception (Jul 2026):** archived **Lookbooks** and archived
    **Content posts** (SocialPost) hard-delete **60 days after archiving**
    (`services/archivePurge.js` — Nate: "for archived stuff like lookbooks…
    make it delete after like 1-2 months"). Scope is STRICTLY these two
    presentation-artifact collections; money/operational archives (Orders,
    Transactions, Clients, POs…) still never delete. Both tabs show the
    per-item countdown; legacy archives get their clock backfilled to the
    deploy date so nothing purges without a full visible grace window.
- **One-time tools auto-hide** once done/empty — never leave leftover cleanup buttons.
- **Printer-network routing & sales-tax NEXUS** are the long-term north star, but do **not**
  encode routing or nexus tax logic without the owner's explicit strategy — he picks
  printers / handles nexus manually today.
- Financial/CRM data lives as committed repo seeds, acceptable **only** because the repos are
  private. Keep it that way.
</content>
