// services/leadScore.js
//
// Lead quality scoring — grades a CRM company by how ACTIONABLE it is for the two
// channels that actually win deals here: cold email and road visits (per
// docs/BUSINESS-MODEL.md — the binding constraint is *quality lead volume*, and
// deals are won by road visits + cold email). A dispensary the owner can email or
// drive to today is higher-"quality" than a bare scraped name; this ranks the book
// so outreach and Today's Run hit the best leads first.
//
// Transparent, weighted points → a letter grade + the reasons behind it. Pure
// (no DB) so it's unit-tested and can run in the list endpoint or a frontend mirror.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function hasEmail(c) {
  if (c.email && EMAIL_RE.test(String(c.email).trim())) return true;
  return (c.contacts || []).some((p) => p && p.email && EMAIL_RE.test(String(p.email).trim()));
}
function hasPhone(c) {
  if (digits(c.phone).length >= 7) return true;
  return (c.contacts || []).some((p) => p && digits(p.phone).length >= 7);
}
// A real street address (contains a number) is road-visitable; the legacy vague
// `area` region alone does not count.
function hasAddress(c) {
  return !!(c.address && /\d/.test(String(c.address)));
}
function hasNamedContact(c) {
  return (c.contacts || []).some((p) => p && p.name && String(p.name).trim());
}

// Weighted points. Reach via the two winning channels dominates.
const WEIGHTS = {
  emailable: 40,  // cold-email-able (top channel) AND not opted out
  address:   25,  // road-visit-able (the other winning channel)
  phone:     15,  // callable
  contact:   10,  // a named person to ask for
  value:     10,  // an estimated deal value already on the card
};

// Grade thresholds on the 0–100 score.
function gradeFor(score) {
  if (score >= 75) return 'A';
  if (score >= 50) return 'B';
  if (score >= 25) return 'C';
  return 'D';
}

function scoreLead(c) {
  if (!c) return { score: 0, grade: 'D', reasons: [] };
  const reasons = [];
  let score = 0;
  const emailPresent = hasEmail(c);
  const emailable = emailPresent && !c.doNotEmail;
  if (emailable) { score += WEIGHTS.emailable; reasons.push('emailable'); }
  else if (emailPresent && c.doNotEmail) reasons.push('do-not-email');
  if (hasAddress(c)) { score += WEIGHTS.address; reasons.push('address'); }
  if (hasPhone(c)) { score += WEIGHTS.phone; reasons.push('callable'); }
  if (hasNamedContact(c)) { score += WEIGHTS.contact; reasons.push('contact'); }
  if (Number(c.dealValue) > 0) { score += WEIGHTS.value; reasons.push('deal-value'); }
  return { score, grade: gradeFor(score), reasons };
}

module.exports = { scoreLead, gradeFor, hasEmail, hasPhone, hasAddress, hasNamedContact, WEIGHTS };
