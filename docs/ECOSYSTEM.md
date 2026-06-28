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

## Hard guardrails (carried from the handoff — do not violate)

- **The sandbox cannot write the production DB.** Any change to LIVE data ships as an in-app
  **preview → confirm** tool the owner runs himself: idempotent, reversible,
  **archive-not-delete**, auto-hides when there's nothing to do. Templates:
  `controllers/dataCleanup` + `DataCleanupView`, `services/financeDedupe`,
  `services/crmReconcile` — persist the snapshot **before** mutating.
- **One-time tools auto-hide** once done/empty — never leave leftover cleanup buttons.
- **Printer-network routing & sales-tax NEXUS** are the long-term north star, but do **not**
  encode routing or nexus tax logic without the owner's explicit strategy — he picks
  printers / handles nexus manually today.
- Financial/CRM data lives as committed repo seeds, acceptable **only** because the repos are
  private. Keep it that way.
</content>
