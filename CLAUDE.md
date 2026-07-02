# Working agreement — website-backend

How to work with Nate on the Joint Printing codebase. **These rules apply to every
request** — follow them by default, not only when asked.

The site is one interconnected ecosystem — `website-backend` (this repo, the API) +
`website-frontend` (the React app) — so most work spans both. Build accordingly.

## 1. Brainstorm before you build
On anything non-trivial, don't jump straight to code — think it through *with me* first:
- Restate what I'm actually after (the goal behind the ask, not just the literal words).
- Propose the smartest way in, and surface any fork worth my input.
- Get a quick 👍, then build.

Trivial / obvious changes (typos, one-liners, mechanical edits) — just do them and
mention it. When unsure, float the approach first; it's cheap.

## 2. Build the smartest, ecosystem-native way
This is an interconnected system. New work should *reflect* that:

- **Reuse, don't reinvent.** Follow the existing shape: HTTP handlers in `controllers/`,
  Mongoose schemas in `models/`, route wiring in `routes/`, integrations/business logic
  in `services/`, cross-cutting concerns in `middleware/`, helpers in `utils/`. Extend the
  existing controller/model/service rather than adding a parallel one.
- **Backend ⇄ frontend.** Most API changes have a `website-frontend` counterpart (a fetch,
  a screen, a deep link). Ship them together, and keep shared constants in sync — the
  frontend keeps commented mirrors of server enums/rates (e.g. CRM stages, status options,
  tax rates); update both sides at once.
- **Data integrity first.** Records are linked by shared identifiers (`companyKey`,
  `orderNumber`, `projectNumber`). Preserve those relationships; think about what else
  reads/writes the same collection and what must stay consistent.
- **Pick the intelligent method, not the quick hack.** Consider migrations, indexes,
  idempotency, and what the owner will want next — not just the immediate endpoint.

## 3. Ship it live, then brief me — no drafts
I don't want to babysit draft PRs. For each change:
1. Implement, then **verify**: `npm test` (node --test suites in `controllers/__tests__`
   / `services/__tests__`) and, when it matters, that `npm start` boots clean.
2. Open a **normal, non-draft PR** with a clear title + body.
3. Once CI is green, **squash-merge to `main`** and confirm the API host redeploys.
4. **Then** give me the overview — what shipped, where, and anything to eyeball.

Only hold instead of shipping if the change is genuinely risky / ambiguous (schema
migrations, destructive data ops) or I told you to wait. If CI is red or a merge
conflicts, fix it and proceed — don't hand me a half-done PR. If a change spans both
repos, ship them together.

## House facts
- **Repos:** `Jointprinting/website-backend` (this — Express + MongoDB/Mongoose API);
  `Jointprinting/website-frontend` (React 18 + MUI 5 on Vercel; the private Studio at
  `/studio` is this API's main client).
- Layout: `server.js` (entry), `controllers/`, `models/`, `routes/`, `services/`,
  `middleware/`, `utils/`, `scripts/` (one-off maintenance/migrations), `apps-script/`.
- Tests run with `node --test`; add coverage next to the code in `__tests__/`.
- **Know the business before advising on it:** `docs/BUSINESS-MODEL.md` (who pays, how
  money is made, funnel, integrations, open questions) and `docs/ECOSYSTEM.md` (the
  canonical order flow + owner decisions). Read them at the start of any non-trivial task.
