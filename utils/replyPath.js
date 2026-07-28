// utils/replyPath.js
//
// "Where does a reply to our cold email actually LAND, and is anyone reading
// that mailbox?" — the single check that makes a zero-reply campaign
// falsifiable.
//
// Cold outreach sends from its own sending identity (a separate mailbox, so the
// owner's real domain never carries cold volume). A reply goes to the Reply-To
// header when one is set, otherwise to the From address. If that mailbox isn't
// the one the reply sync is authenticated as, every reply the campaign has ever
// produced is sitting somewhere nobody opens — and the Studio's reply counter is
// reading a DIFFERENT inbox, so "0 replies" means "not measured", not "none".
//
// replyPathStatus() is PURE and dependency-free: callers pass the addresses in
// (services/outreachEngine resolves the sending side, controllers/replyTriage
// the reading side). It NEVER throws and NEVER invents an address — anything it
// can't determine degrades to level 'ok' with monitored:false, so a missing
// value can't manufacture a scary alert.
//
//   node --test utils/__tests__/replyPath.test.js

// Pull the bare address out of anything an env var or header might hold:
// 'Nate <Nate@X.com>', ' <nate@x.com> ', 'NATE@X.COM ' → 'nate@x.com'.
function normalizeAddress(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  const angle = s.match(/<([^<>]+)>\s*$/);
  const raw = angle ? angle[1] : s;
  return raw.trim().replace(/^["'<]+|["'>,;]+$/g, '').trim().toLowerCase();
}

// Classify the reply path.
//   from             — the campaign's From address
//   replyTo          — the Reply-To it sets (blank = replies go to From)
//   triageAddress    — the mailbox the reply sync is authenticated as
//   triageConfigured — whether that sync is switched on at all
//   ownerAddress     — the inbox the owner actually reads every day
//
// Levels:
//   'action' — a reply can never be seen: the mailbox it lands in isn't the one
//              being read, or nothing is reading any mailbox at all.
//   'warn'   — the sync reads the right mailbox, but it isn't the owner's own
//              inbox, so he only sees replies inside the Studio.
//   'ok'     — reading matches sending (or there's nothing to judge yet).
function replyPathStatus({
  from = '',
  replyTo = '',
  triageAddress = '',
  triageConfigured = false,
  ownerAddress = '',
} = {}) {
  const fromAddr = normalizeAddress(from);
  const replyToAddr = normalizeAddress(replyTo);
  const triage = normalizeAddress(triageAddress);
  const owner = normalizeAddress(ownerAddress);
  const configured = !!triageConfigured;

  // Where a reply ACTUALLY lands: Reply-To wins, else the From address.
  const destination = replyToAddr || fromAddr;
  const monitored = !!(configured && triage && destination && triage === destination);

  let level = 'ok';
  let label = '';
  let hint = '';

  if (!destination) {
    label = 'Reply path unknown';
    hint = 'No sending address is configured yet, so there’s nothing to reply to. Set the outreach from-address on the API first.';
  } else if (!configured) {
    level = 'action';
    label = 'Nothing is reading replies';
    hint = `Replies to your cold email land in ${destination}, but reply sync is switched off — nobody and nothing is checking that mailbox. Fix: connect the reply inbox (Gmail triage) to ${destination}, or turn on forwarding from it to an inbox you read.`;
  } else if (!triage) {
    // Sync is on but we can't tell which mailbox it authenticated as — say so
    // plainly rather than guessing an address or crying wolf.
    label = 'Reply mailbox unverified';
    hint = `Replies to your cold email land in ${destination}. Reply sync is on, but we can’t confirm which mailbox it’s signed in to — run a sync once so it records its own address, then re-check this.`;
  } else if (triage !== destination) {
    // The black hole: mail goes one place, the Studio reads another.
    level = 'action';
    label = 'Replies land in a mailbox nobody reads';
    hint = `Replies to your cold email land in ${destination}, but the Studio reads ${triage} — you will never see them. Fix: point the reply sync (GMAIL_* on the API) at ${destination} so leads surface here in the Studio. Alternative, if you'd rather have replies in your own mail: set OUTREACH_REPLY_TO=${triage}, or forward ${destination} → ${triage}.`;
  } else {
    // Reading matches sending. This is the INTENDED design, including — in fact
    // especially — when the sending mailbox isn't the owner's day-to-day inbox:
    // cold volume, its bounces and its opt-outs stay quarantined off the real
    // inbox, and the Studio is the one place a genuine lead has to show up. An
    // earlier version warned here; that was backwards, and nagging about the
    // desired state is how a real alert stops being read.
    label = 'Replies land where you’ll see them';
    hint = owner && destination !== owner
      ? `Replies land in ${destination} and the Studio reads that mailbox, so a real lead shows up on the Outreach tab — ${owner} stays clear of cold-email traffic and its bounces. Nothing to do.`
      : `Replies to your cold email land in ${destination}, which is the mailbox the Studio reads. Nothing to do.`;
  }

  return { level, label, hint, destination, triageAddress: triage, monitored };
}

module.exports = { replyPathStatus, normalizeAddress };
