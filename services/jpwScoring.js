// services/jpwScoring.js
//
// 100-point lead scoring for the JP Webworks recon engine. Mirrors the GPT
// spec exactly. Inputs: a JpwLead-shaped object (POJO or Mongoose doc).
// Outputs: { score, grade, breakdown, recommendedOffer, reasonSummary,
//            mainPainPoints, buyingSignals, disqualifiers, opener, pitchAngle }
//
// Score is optimized for BOOKABLE deals, not "needs help" alone. A business
// with terrible web presence but no signs they'd pay gets ranked below one
// with mediocre web presence that's clearly spending money.
//
// All sub-scores are independently capped; total cannot exceed 100 even
// before penalties. Penalties can push the total negative; we floor at 0
// for display but keep the raw value in `breakdown.rawTotal` for debugging.

const {
  SCORE_CAPS,
  SCORE_TOTAL_CAP,
  gradeFor,
  categoryMeta,
  SOUTH_JERSEY_COUNTIES,
  OFFERS,
} = require('./jpwConstants');

// ── Helpers ───────────────────────────────────────────────────────────────
function cap(val, max) { return Math.min(Math.max(val, 0), max); }

// Some boolean fields are stored as null when "not audited yet" — we don't
// want to penalize for missing audit data on a fresh lead. `missing` returns
// true only for explicit false/0, not for null/undefined.
function isExplicitlyFalsy(v) {
  return v === false || v === 0;
}

const AD_INTENT_PHRASES = [
  /\bfree estimate\b/i, /\bfree quote\b/i, /\bcall now\b/i, /\bbook (now|today)\b/i,
  /\bschedule\b/i, /\bemergency\b/i, /\b24[- /]?7\b/i, /\bfinancing\b/i,
  /\blimited time\b/i, /\bsame[- ]day\b/i, /\bno obligation\b/i,
];

// ── A. Buying Intent (0–30) ──────────────────────────────────────────────
function scoreBuyingIntent(lead) {
  const reasons = [];
  let s = 0;
  const ad = lead.ad_signal || {};
  const audit = lead.website_audit || {};

  // Ads — confirmed beats possible
  if (ad.active_ads_found === true) {
    s += 15;
    reasons.push('Active Meta ads confirmed');
  } else if (ad.active_ads_found === 'possible' || ad.confidence === 'possible') {
    s += 8;
    reasons.push('Possible active Meta ads');
  }
  if (ad.active_ad_count >= 2) {
    s += 4;
    reasons.push(`${ad.active_ad_count} active ads running`);
  }
  // Ad copy intent language
  const adText = [
    ad.ad_angle_summary,
    ...(ad.ad_text_samples || []),
  ].filter(Boolean).join(' ');
  if (adText && AD_INTENT_PHRASES.some((rx) => rx.test(adText))) {
    s += 4;
    reasons.push('Ad copy uses high-intent language');
  }

  // Review count tiers (Google reviews — strong demand signal)
  const rc = lead.review_count || 0;
  if (rc >= 150)      { s += 7; reasons.push(`${rc} Google reviews — proven demand`); }
  else if (rc >= 50)  { s += 5; reasons.push(`${rc} Google reviews — solid demand`); }
  else if (rc >= 25)  { s += 3; reasons.push(`${rc} Google reviews — modest demand`); }

  // Website signals
  if (audit.has_tracking_pixels) {
    s += 3;
    reasons.push('Tracking pixels installed (running paid traffic)');
  }
  if (audit.has_landing_page_structure) {
    s += 2;
    reasons.push('Landing-page style site (running campaigns)');
  }
  if (audit.service_area_count >= 3) {
    s += 2;
    reasons.push('Multiple service areas listed');
  }

  return { value: cap(s, SCORE_CAPS.buyingIntent), reasons };
}

// ── B. Pain (0–25) ────────────────────────────────────────────────────────
function scorePain(lead) {
  const reasons = [];
  let s = 0;
  const audit = lead.website_audit || {};
  const hasWebsite = !!(lead.website_url || lead.domain);

  if (!hasWebsite) {
    s += 10;
    reasons.push('No website at all');
  } else {
    if (audit.loads_successfully === false || (audit.status_code && audit.status_code >= 400)) {
      s += 8;
      reasons.push('Website loads poorly or errors');
    }
    if (isExplicitlyFalsy(audit.has_click_to_call)) {
      s += 5;
      reasons.push('No click-to-call link');
    }
    if (isExplicitlyFalsy(audit.has_quote_cta)) {
      s += 5;
      reasons.push('No quote / request-estimate CTA');
    }
    if (isExplicitlyFalsy(audit.has_contact_form)) {
      s += 4;
      reasons.push('No contact form');
    }
    if (isExplicitlyFalsy(audit.has_meta_description) || isExplicitlyFalsy(audit.has_title)) {
      s += 3;
      reasons.push('Weak/missing meta tags');
    }
    if (isExplicitlyFalsy(audit.has_service_area_terms)) {
      s += 4;
      reasons.push('No service-area pages or town mentions');
    }
    if (isExplicitlyFalsy(audit.has_reviews_on_site)) {
      s += 3;
      reasons.push('No reviews/testimonials on site');
    }
    if (isExplicitlyFalsy(audit.has_gallery)) {
      s += 3;
      reasons.push('No gallery / before-after proof');
    }
    if (audit.outdated_copyright === true) {
      s += 2;
      reasons.push('Outdated copyright year');
    }
    if (audit.mobile_speed_score !== undefined && audit.mobile_speed_score !== null
        && audit.mobile_speed_score < 50) {
      s += 4;
      reasons.push(`Bad mobile speed (${audit.mobile_speed_score})`);
    }
    if (isExplicitlyFalsy(audit.has_localbusiness_schema)) {
      s += 3;
      reasons.push('No LocalBusiness schema');
    }
  }

  return { value: cap(s, SCORE_CAPS.pain), reasons };
}

// ── C. Ability to Pay (0–25) ──────────────────────────────────────────────
function scoreAbilityToPay(lead) {
  const reasons = [];
  let s = 0;
  const meta = categoryMeta(lead.category);
  const rc = lead.review_count || 0;
  const rating = lead.rating || 0;
  const audit = lead.website_audit || {};
  const ad = lead.ad_signal || {};

  if (meta?.tier === 'high') {
    s += 8;
    reasons.push(`${lead.category} is a high-ticket category`);
  }

  // Review-count band (mutually exclusive — higher band only)
  if (rc >= 150)      { s += 7; reasons.push('150+ reviews — proven revenue'); }
  else if (rc >= 50)  { s += 5; reasons.push('50+ reviews — established'); }

  if (rating >= 4.2 && rc >= 25) {
    s += 3;
    reasons.push(`${rating.toFixed(1)}★ across ${rc} reviews`);
  }

  if (lead.website_url && (
    audit.loads_successfully === false ||
    isExplicitlyFalsy(audit.has_click_to_call) ||
    isExplicitlyFalsy(audit.has_quote_cta)
  )) {
    s += 4;
    reasons.push('Has paid for a website before — now needs better work');
  }

  if (ad.active_ads_found === true || ad.active_ads_found === 'possible') {
    s += 5;
    reasons.push('Already paying for ads — has a marketing budget');
  }

  if (audit.service_area_count >= 3) {
    s += 4;
    reasons.push('Operating across multiple service areas');
  }

  if (meta?.emergency) {
    s += 2;
    reasons.push('Emergency-service category — high per-job value');
  }

  return { value: cap(s, SCORE_CAPS.abilityToPay), reasons };
}

// ── D. Fit (0–15) ────────────────────────────────────────────────────────
function scoreFit(lead) {
  const reasons = [];
  let s = 0;
  const meta = categoryMeta(lead.category);

  if (lead.state === 'NJ' && SOUTH_JERSEY_COUNTIES.some(
    (c) => (lead.county || '').toLowerCase().includes(c.toLowerCase())
  )) {
    s += 5;
    reasons.push('Inside South Jersey target geography');
  }

  if (!lead.is_franchise) {
    s += 4;
    reasons.push('Independent / local business');
  }

  if (meta && meta.tier !== 'disqualify') {
    s += 4;
    reasons.push('Phone-driven, quote-based business');
  }

  if (meta?.tier === 'high' || meta?.tier === 'mid') {
    s += 2;
    reasons.push('Maps to a JPW core offer');
  }

  return { value: cap(s, SCORE_CAPS.fit), reasons };
}

// ── E. Urgency (0–5) ─────────────────────────────────────────────────────
const SEASONAL_NOW = (() => {
  // Northeast US — spring/summer/fall = peak for outdoor service categories.
  // Updated lazily on import. Tight enough; we don't need per-week granularity.
  const m = new Date().getMonth();
  return {
    spring_summer_fall: m >= 2 && m <= 10, // Mar–Nov
  };
})();

function scoreUrgency(lead) {
  const reasons = [];
  let s = 0;
  const meta = categoryMeta(lead.category);
  const ad = lead.ad_signal || {};

  if (SEASONAL_NOW.spring_summer_fall && meta?.tier === 'high'
      && /tree|stump|roof|excavat|hardscap|paving|concrete|fence|gutter|paint|landscap/i.test(lead.category || '')) {
    s += 2;
    reasons.push('Seasonal demand active now');
  }
  if (meta?.emergency) {
    s += 2;
    reasons.push('Emergency category — customers calling under pressure');
  }
  if (ad.latest_seen_date) {
    const days = (Date.now() - new Date(ad.latest_seen_date).getTime()) / 86400000;
    if (days <= 30) {
      s += 1;
      reasons.push('Ad activity in the last 30 days');
    }
  }

  return { value: cap(s, SCORE_CAPS.urgency), reasons };
}

// ── Penalties ────────────────────────────────────────────────────────────
//
// Penalties subtract from total. Hard-exclusion ones (closed business, etc.)
// surface as a disqualifier so the UI can pull them out of the call queue,
// not just rank them low.
function evaluatePenalties(lead) {
  const penalties = [];
  const disqualifiers = [];
  let delta = 0;

  if (lead.business_status === 'CLOSED_PERMANENTLY') {
    disqualifiers.push('Permanently closed');
  }
  if (!lead.phone || !lead.normalized_phone) {
    delta -= 20;
    penalties.push('No phone number (-20)');
  }
  // South Jersey check — only penalize when we KNOW the state/county is wrong,
  // not when it's unset (manual entries often skip state).
  if (lead.state && lead.state !== 'NJ') {
    delta -= 25;
    penalties.push('Outside NJ (-25)');
  } else if (lead.county && !SOUTH_JERSEY_COUNTIES.some(
    (c) => lead.county.toLowerCase().includes(c.toLowerCase())
  )) {
    delta -= 25;
    penalties.push('Outside South Jersey (-25)');
  }
  if (lead.is_franchise) {
    delta -= 25;
    penalties.push('National franchise (-25)');
  }
  const meta = categoryMeta(lead.category);
  if (meta?.tier === 'disqualify') {
    delta -= 15;
    penalties.push(`Low-ticket category: ${lead.category} (-15)`);
  }

  // "Too polished" — strong site + ads + 4.5+ rating with massive review count =
  // they already have an agency, hard to displace
  const audit = lead.website_audit || {};
  const ad = lead.ad_signal || {};
  if (audit.has_click_to_call && audit.has_quote_cta && audit.has_localbusiness_schema
      && audit.mobile_speed_score >= 80
      && ad.active_ads_found === true && (lead.review_count || 0) >= 200) {
    delta -= 20;
    penalties.push('Already polished — likely has an agency (-20)');
  }
  if ((lead.review_count || 0) < 10 && !ad.active_ads_found) {
    delta -= 20;
    penalties.push('Under 10 reviews and no ad signal (-20)');
  }
  if (!lead.website_url && (lead.review_count || 0) < 10 && !ad.active_ads_found) {
    delta -= 25;
    penalties.push('No website, no reviews, no demand signals (-25)');
  }
  if (lead.address_residential_only) {
    delta -= 15;
    penalties.push('Residential address, no business footprint (-15)');
  }

  return { delta, penalties, disqualifiers };
}

// ── Offer recommendation ────────────────────────────────────────────────
//
// Pick which JPW offer best fits the lead's weakness pattern. Order matters:
// fullGrowth wins if multiple high-value conditions hit, then metaAds (we have
// proof of ad spend), then localSeo (Google opportunity), then foundation.
function recommendOffer(lead) {
  const audit = lead.website_audit || {};
  const ad = lead.ad_signal || {};
  const rc = lead.review_count || 0;
  const meta = categoryMeta(lead.category);
  const hasWebsite = !!lead.website_url;
  const weakConversion = isExplicitlyFalsy(audit.has_click_to_call)
                       || isExplicitlyFalsy(audit.has_quote_cta)
                       || isExplicitlyFalsy(audit.has_contact_form);

  // Full Growth: ads + high-ticket + reviews + weak site
  if ((ad.active_ads_found === true || ad.active_ads_found === 'possible')
      && meta?.tier === 'high' && rc >= 50 && weakConversion) {
    return {
      offer: OFFERS.fullGrowth,
      pitch: 'You do not need one random fix. You need the site, Google, and ads working together as one lead system.',
    };
  }
  // Meta Ads: they're paying for clicks, funnel is weak
  if ((ad.active_ads_found === true || ad.active_ads_found === 'possible')
      && (weakConversion || hasWebsite)) {
    return {
      offer: OFFERS.metaAds,
      pitch: "You're already paying for attention. The question is whether the clicks are being turned into calls.",
    };
  }
  // Local SEO: decent site exists, Google presence weak, high intent search category
  if (hasWebsite && rc >= 25 && meta?.tier === 'high'
      && (isExplicitlyFalsy(audit.has_localbusiness_schema)
          || isExplicitlyFalsy(audit.has_service_area_terms))) {
    return {
      offer: OFFERS.localSeo,
      pitch: 'People are searching for this already. The opportunity is getting you showing up stronger and turning that visibility into calls.',
    };
  }
  // Foundation: no website OR a broken/weak one in a high-ticket category
  if (!hasWebsite || audit.loads_successfully === false || weakConversion) {
    return {
      offer: OFFERS.foundation,
      pitch: 'Your foundation is the issue. Before ads or SEO, people need a clean place to land and call.',
    };
  }
  // Default — local SEO is the safest cross-sell
  return {
    offer: OFFERS.localSeo,
    pitch: 'There is room to get you showing up stronger on Google and turning that visibility into calls.',
  };
}

// ── Opener generation ───────────────────────────────────────────────────
//
// Picks one of the four GPT-spec'd openers based on the lead's profile, then
// fills in business name + category. Kept rule-based for Phase 1 — Phase 6
// can swap in an LLM-generated variation if we want.
function generateOpener(lead) {
  const ad = lead.ad_signal || {};
  const audit = lead.website_audit || {};
  const hasWebsite = !!lead.website_url;
  const rc = lead.review_count || 0;
  const meta = categoryMeta(lead.category);
  const name = lead.business_name || 'your business';
  const weakSite = !hasWebsite || audit.loads_successfully === false
                || isExplicitlyFalsy(audit.has_click_to_call)
                || isExplicitlyFalsy(audit.has_quote_cta);

  if ((ad.active_ads_found === true || ad.active_ads_found === 'possible') && weakSite) {
    return `Hey, is this the owner of ${name}? Nate from JP Webworks. Quick reason I'm calling — I saw you're already putting money into getting more work, and I noticed the website/Google side may not be turning enough of that attention into calls.`;
  }
  if (hasWebsite && rc >= 25 && (isExplicitlyFalsy(audit.has_localbusiness_schema) || isExplicitlyFalsy(audit.has_service_area_terms))) {
    const cat = lead.category ? `local ${lead.category.toLowerCase()}` : 'local service';
    return `Hey, is this the owner of ${name}? Nate from JP Webworks. I was looking at ${cat} companies in South Jersey and noticed your business looks legit, but there may be room to get you showing up stronger when people search nearby.`;
  }
  if (!hasWebsite && rc >= 25) {
    return `Hey, is this the owner of ${name}? Nate from JP Webworks. I saw you've got real customer proof already, but when people look you up there isn't a strong site making it easy to call or request an estimate.`;
  }
  if (meta?.tier === 'high') {
    return `Hey, is this the owner of ${name}? Nate from JP Webworks. I help local service companies turn more searches into calls. I noticed a few simple things online that could be costing you estimate requests.`;
  }
  return `Hey, is this the owner of ${name}? Nate from JP Webworks. I help local service businesses get more calls from their site and Google profile — wanted to share a couple of quick things I noticed about yours.`;
}

// ── Top-level scorer ────────────────────────────────────────────────────
function scoreLead(lead) {
  const buying = scoreBuyingIntent(lead);
  const pain = scorePain(lead);
  const ability = scoreAbilityToPay(lead);
  const fit = scoreFit(lead);
  const urgency = scoreUrgency(lead);
  const positiveTotal = buying.value + pain.value + ability.value + fit.value + urgency.value;
  const penaltyResult = evaluatePenalties(lead);
  const rawTotal = positiveTotal + penaltyResult.delta;
  const displayTotal = Math.max(0, Math.min(SCORE_TOTAL_CAP, rawTotal));
  const grade = penaltyResult.disqualifiers.length ? 'D' : gradeFor(rawTotal);

  const offerRec = recommendOffer(lead);
  const opener = generateOpener(lead);

  // Reasons live inside the breakdown so the UI can show "why did this
  // bar score X" right next to each progress bar. Top-level mainPainPoints
  // / buyingSignals retained for backwards compatibility with older clients
  // and exports.
  const mainPainPoints = pain.reasons.slice(0, 3);
  const buyingSignals = buying.reasons.slice(0, 2);

  const reasonSummary = [
    `${grade} — ${displayTotal}/100`,
    offerRec.offer,
    mainPainPoints[0] || 'No specific weakness flagged',
  ].filter(Boolean).join(' · ');

  return {
    score: displayTotal,
    grade,
    breakdown: {
      buyingIntent: { value: buying.value,  reasons: buying.reasons },
      pain:         { value: pain.value,    reasons: pain.reasons },
      abilityToPay: { value: ability.value, reasons: ability.reasons },
      fit:          { value: fit.value,     reasons: fit.reasons },
      urgency:      { value: urgency.value, reasons: urgency.reasons },
      rawTotal,
      penaltyDelta: penaltyResult.delta,
    },
    recommendedOffer: offerRec.offer,
    pitchAngle: offerRec.pitch,
    opener,
    reasonSummary,
    mainPainPoints,
    buyingSignals,
    disqualifiers: penaltyResult.disqualifiers,
    penalties: penaltyResult.penalties,
    scoredAt: new Date(),
  };
}

// Whether a lead belongs in "Call Today" — stricter than just A+/A grade.
// Mirrors the meeting-fit rules in the spec.
function isCallTodayWorthy(lead, scoreResult = null) {
  const s = scoreResult || scoreLead(lead);
  if (s.disqualifiers.length) return false;
  if (s.score >= 72) return true;
  const ad = lead.ad_signal || {};
  const audit = lead.website_audit || {};
  const hasWebsite = !!lead.website_url;
  const rc = lead.review_count || 0;
  const meta = categoryMeta(lead.category);
  const weakSite = !hasWebsite || audit.loads_successfully === false
                || isExplicitlyFalsy(audit.has_click_to_call)
                || isExplicitlyFalsy(audit.has_quote_cta);

  if ((ad.active_ads_found === true || ad.active_ads_found === 'possible') && weakSite) return true;
  if (rc >= 50 && meta?.tier === 'high' && weakSite) return true;
  if (!hasWebsite && meta?.tier === 'high' && rc >= 50) return true;
  return false;
}

module.exports = {
  scoreLead,
  isCallTodayWorthy,
  recommendOffer,
  generateOpener,
};
