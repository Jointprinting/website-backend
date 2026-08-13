// services/agentLifecycle.js
//
// The canonical onboarding checklist for a sales agent, and the GATES it drives.
// Pure, no DB, no Express — the same definition renders the owner's checklist,
// decides what an agent may reach, and answers "am I clear to pay this person".
//
// WHY A CHECKLIST IS A GATE, NOT A TO-DO LIST
// A list you can tick in any order is a decoration. These steps exist because
// each one blocks a real risk: paying someone with no W-9 exposes the payer to
// 24% backup withholding; letting someone sell before the agreement is signed
// means no confidentiality, no non-solicit and no indemnity for anything they
// say; and switching commission on before terms are agreed shows a rep a number
// nobody promised. So the steps are ordered into STAGES, and later stages
// refuse to open until the earlier ones are done.
//
// WHAT IS DELIBERATELY NOT STORED
// The W-9 itself is tracked as RECEIVED — the file is never uploaded here. This
// stack's only object storage (Cloudflare R2) is a public-read bucket: the URL
// IS the credential, there is no signing dependency, and objects are written
// immutable with a one-year CDN cache. A W-9 carries a Social Security Number.
// Putting one there would create a permanent, unrevocable, world-readable copy
// of a person's SSN, so this module records the FACT of compliance plus the last
// four digits (all that is needed to reference a 1099) and points the owner at
// storing the document itself somewhere built for it. That is a deliberate
// refusal, not a missing feature.

// Stage order matters: a stage cannot be entered until every REQUIRED step in
// every earlier stage is done. Keys are stored on AdminUser.onboarding and must
// never be renamed without a migration (they are the persisted identity).
const STAGES = [
  {
    key: 'terms',
    label: 'Agree the deal',
    blurb: 'Before anything is signed — make sure you both want the same job.',
    steps: [
      { key: 'screened',      label: 'Screened and offered',        required: true,
        help: 'You have met, agreed the role, and told them the honest earnings range.' },
      { key: 'rates_agreed',  label: 'Commission terms agreed',     required: true,
        help: 'Rates, lead-source split and reorder rule discussed out loud, not just sent.' },
      { key: 'other_clients', label: 'Confirmed they sell elsewhere', required: false,
        help: 'A contractor with other clients is far easier to defend as a contractor. Not a blocker, but record the answer.' },
    ],
  },
  {
    key: 'paperwork',
    label: 'Paperwork',
    blurb: 'Nothing below this line happens until these are physically in hand.',
    steps: [
      { key: 'agreement_signed', label: 'Contractor agreement signed', required: true,
        help: 'Confidentiality, customer non-solicit, non-disparagement, indemnity and the limits on their authority all live in this one document.' },
      { key: 'w9_received',      label: 'W-9 received',               required: true,
        help: 'Record that you HAVE it and the last four of the TIN. Do not upload the form — it carries an SSN and this system has no private file storage.' },
      { key: 'coi_received',     label: 'Certificate of insurance',   required: false,
        help: 'An indemnity from someone with no assets is a promise; the COI is what makes it collectible.' },
    ],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    blurb: 'Access is the last thing to hand over — easier to give than to take back.',
    steps: [
      { key: 'email_created',  label: 'Company email created', required: false,
        help: 'You own the mailbox, so their conversation with your client does not leave with them.' },
      { key: 'studio_created', label: 'Studio login created',  required: true,
        help: 'Creating the account here is this step.' },
      { key: 'goal_set',       label: 'Monthly goal set',      required: false,
        help: 'Keep it low for the first 60 days — the dashboard says "behind pace" the moment a goal exists.' },
    ],
  },
  {
    key: 'enablement',
    label: 'Ready to sell',
    blurb: 'What turns access into a rep who can actually close.',
    steps: [
      { key: 'walkthrough_done', label: 'Walked one order end to end', required: true,
        help: 'Screen-share a real order through quote, mockup, confirmation and P&L.' },
      { key: 'first_quote_shadowed', label: 'First quote reviewed with you', required: false,
        help: 'Check the first one before they send it solo. Cheapest possible correction.' },
      { key: 'commission_on',    label: 'Commission switched on',      required: true,
        help: 'Flips their Earnings tab on. Do it once terms are real, not before.' },
    ],
  },
];

const STAGE_KEYS = STAGES.map((s) => s.key);
const ALL_STEPS = STAGES.flatMap((s) => s.steps.map((st) => ({ ...st, stage: s.key })));
const STEP_KEYS = ALL_STEPS.map((s) => s.key);

// Normalize whatever shape the completions arrived in (a Mongoose Map, a plain
// object, or nothing) into a plain { key: {doneAt, by, note} }. Unknown keys are
// dropped so a renamed step can't resurrect as a phantom tick.
function normalizeCompletions(raw) {
  if (!raw) return {};
  const src = typeof raw.toObject === 'function' ? raw.toObject()
    : (raw instanceof Map ? Object.fromEntries(raw) : raw);
  const out = {};
  for (const k of STEP_KEYS) {
    const v = src && src[k];
    if (!v) continue;
    const at = v.doneAt || v.at || v;
    const d = at instanceof Date ? at : new Date(at);
    if (isNaN(d.getTime())) continue;
    out[k] = { doneAt: d, by: String(v.by || ''), note: String(v.note || '') };
  }
  return out;
}

// The checklist as the UI should render it: every stage, every step, whether it
// is done, and — the important part — whether the stage is REACHABLE yet.
function checklistFor(agent) {
  const done = normalizeCompletions(agent && agent.onboarding);
  let earlierBlocked = false;
  const stages = STAGES.map((stage) => {
    const steps = stage.steps.map((st) => ({
      ...st, stage: stage.key,
      done: !!done[st.key],
      doneAt: done[st.key] ? done[st.key].doneAt : null,
      note: done[st.key] ? done[st.key].note : '',
    }));
    const missingRequired = steps.filter((s) => s.required && !s.done);
    const out = {
      ...stage,
      steps,
      complete: missingRequired.length === 0,
      missingRequired: missingRequired.map((s) => s.key),
      // Locked while ANY earlier stage still has required work outstanding.
      locked: earlierBlocked,
    };
    if (missingRequired.length) earlierBlocked = true;
    return out;
  });
  const requiredTotal = ALL_STEPS.filter((s) => s.required).length;
  const requiredDone = ALL_STEPS.filter((s) => s.required && done[s.key]).length;
  return {
    stages,
    requiredTotal,
    requiredDone,
    progress: requiredTotal ? requiredDone / requiredTotal : 1,
    complete: requiredDone === requiredTotal,
  };
}

// THE GATES. Each answers one question the rest of the app should ask rather
// than re-deriving. `ok:false` always carries a `why` the UI can show verbatim,
// so a blocked action explains itself instead of just being greyed out.
function gates(agent) {
  const done = normalizeCompletions(agent && agent.onboarding);
  const has = (k) => !!done[k];

  const maySell = has('agreement_signed');
  const mayBePaid = has('agreement_signed') && has('w9_received');

  return {
    // Can this person legitimately be out representing the company?
    maySell: {
      ok: maySell,
      why: maySell ? '' : 'No signed agreement — nothing protects the client list, and anything they promise is unindemnified.',
    },
    // Can a commission cheque be cut? W-9 is the hard one: without a certified
    // TIN the payer owes 24% backup withholding out of their own pocket.
    mayBePaid: {
      ok: mayBePaid,
      why: !has('agreement_signed') ? 'No signed agreement — there are no agreed terms to pay against.'
        : !has('w9_received') ? 'No W-9 on file — paying without one means owing 24% backup withholding yourself.'
        : '',
    },
    // Should commission be switched on for them yet?
    mayEnableCommission: {
      ok: mayBePaid && has('rates_agreed'),
      why: !has('rates_agreed') ? 'Rates have not been agreed with them yet.'
        : !mayBePaid ? 'Paperwork is not complete — see above.' : '',
    },
  };
}

// The status a lifecycle change implies, so the owner never has to keep
// `status` and `active` in sync by hand. Returns null when nothing should move.
function impliedStatus(agent) {
  if (!agent) return null;
  if (agent.departedAt) return 'departed';
  if (agent.active === false) return 'paused';
  return checklistFor(agent).complete ? 'active' : 'onboarding';
}

module.exports = {
  STAGES, STAGE_KEYS, ALL_STEPS, STEP_KEYS,
  normalizeCompletions, checklistFor, gates, impliedStatus,
};
