---
name: how-we-work
description: Nate's standing workflow for the Joint Printing ecosystem (website-backend API + website-frontend app). Invoke to (re)assert how to work on any task here — brainstorm the approach first, build the smartest ecosystem-native way by extending existing controllers/models/services and keeping the frontend counterpart + shared constants in sync, then ship it live (non-draft PR → squash-merge → deploy) before summarizing. Use at the start of a task, or any time the working style needs a reset. Mirrors CLAUDE.md, which already applies these to every request.
---

# How we work (Nate's workflow)

Apply this to the current task. These are the same rules as the repo's `CLAUDE.md`
(which applies to *every* request); invoke this skill to re-assert them explicitly.

## 1. Brainstorm first
Non-trivial request → don't jump to code. Restate the real goal, propose the smartest
approach, surface any fork worth Nate's input, get a quick 👍, then build. Trivial/obvious
changes: just do them and mention it.

## 2. Smartest, ecosystem-native method
The site is one interconnected system (backend API ⇄ frontend app; records linked by
`companyKey` / `orderNumber` / `projectNumber`).
- **Reuse** the existing shape: `controllers/`, `models/`, `routes/`, `services/`,
  `middleware/`, `utils/`. Extend what's there rather than adding a parallel path.
- **Keep both sides in sync**: most API changes need a `website-frontend` counterpart, and
  the frontend keeps commented mirrors of server enums/rates — update both at once.
- **Data integrity first**: preserve the shared-ID relationships; think migrations,
  indexes, idempotency, and what else touches the same collection.

## 3. Ship it live, then brief — no drafts
Implement → verify (`npm test`; `npm start` boots clean when it matters) → **non-draft**
PR → squash-merge to `main` once green → confirm the API host redeploys → *then* give the
overview. Fix red CI / conflicts and proceed; only hold if it's genuinely risky/ambiguous
(schema migrations, destructive ops) or Nate said wait. Changes spanning both repos ship
together.
