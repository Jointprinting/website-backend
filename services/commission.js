// services/commission.js
//
// The commission math for sales agents — pure, dependency-free, unit-tested.
// No DB, no Express: given a rate config and an order's economics, it says what
// the agent earned and why. Everything the owner's Team tab and the agent's
// My Earnings tab display comes from here, so the two views can never disagree.
//
// THE MODEL (defaults mirror the plan in the onboarding brief; every number is
// owner-editable per agent on AdminUser.commission, so changing the deal is a
// settings edit, not a deploy):
//
//   • Commission is a % of an order's GROSS PROFIT — revenue minus the six
//     COGS categories (blanks, printing, shipping, art, commission, processing
//     fee). Never a % of revenue. Discounting to close therefore costs the
//     agent first, which is the whole point: the maths IS the margin floor.
//   • Profit is measured BEFORE this agent's own commission, or the calculation
//     is circular. (That is also how the historical Alvin rows were computed.)
//   • The rate depends on where the client came from:
//       self    — the agent sourced the company (originAgentId is theirs)
//       house   — the owner handed them the lead; paid on the FIRST order only
//       reorder — a repeat order from a client the agent originally sourced
//   • A LADDER lifts the self rate as the agent's lifetime sourced profit grows.
//     Cumulative and lifetime, so it never ratchets back down — that is the
//     "loyalty" half of the design, and it means one number does both jobs.
//   • FAST START: the first N completed self-sourced orders pay at the second
//     tier's rate whatever tier the agent is actually on, so a new rep sees a
//     real number early without the owner carrying a draw.
//
// Nothing here decides WHEN money is owed — that is `earnedState` below, and it
// is deliberately strict: delivered AND paid.

// Owner-editable defaults, applied to every new agent. Percentages are of
// gross profit. `houseReordersPay: false` encodes "house leads pay on the first
// order only" — after that the account is the owner's.
const DEFAULT_COMMISSION = {
  enabled: false,          // off until the owner turns it on for that agent
  fastStartOrders: 3,      // first N completed self-sourced orders ride tier 2
  houseReordersPay: false,
  tiers: [
    { name: 'Starter',     minLifetimeProfit: 0,     selfPct: 30, housePct: 15,   reorderPct: 15 },
    { name: 'Established', minLifetimeProfit: 15000, selfPct: 35, housePct: 17.5, reorderPct: 17.5 },
    { name: 'Partner',     minLifetimeProfit: 40000, selfPct: 40, housePct: 20,   reorderPct: 20 },
  ],
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const clampPct = (v) => Math.min(100, Math.max(0, num(v)));

// Normalize whatever is stored (or missing) into a usable config. A partial or
// empty `commission` sub-doc on an older AdminUser row must never throw or
// silently pay 0% — it falls back to the defaults, sorted so tier lookup is a
// simple scan.
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const tiers = (Array.isArray(c.tiers) && c.tiers.length ? c.tiers : DEFAULT_COMMISSION.tiers)
    .map((t, i) => ({
      name: String((t && t.name) || `Tier ${i + 1}`),
      minLifetimeProfit: Math.max(0, num(t && t.minLifetimeProfit)),
      selfPct: clampPct(t && t.selfPct),
      housePct: clampPct(t && t.housePct),
      reorderPct: clampPct(t && t.reorderPct),
    }))
    .sort((a, b) => a.minLifetimeProfit - b.minLifetimeProfit);
  return {
    enabled: !!c.enabled,
    fastStartOrders: Math.max(0, Math.floor(num(c.fastStartOrders ?? DEFAULT_COMMISSION.fastStartOrders))),
    houseReordersPay: c.houseReordersPay == null ? DEFAULT_COMMISSION.houseReordersPay : !!c.houseReordersPay,
    tiers,
  };
}

// Which tier a lifetime sourced-profit figure lands in. Highest threshold that
// the figure meets or exceeds; always at least the first tier, so an agent with
// $0 (or a config whose lowest threshold is above 0) still has a rate.
function tierFor(lifetimeProfit, config) {
  const { tiers } = normalizeConfig(config);
  const p = num(lifetimeProfit);
  let idx = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    if (p >= tiers[i].minLifetimeProfit) idx = i;
  }
  return { index: idx, ...tiers[idx] };
}

// What's left to climb. `null` at the top tier so the UI can say "top tier"
// rather than render an unreachable bar.
function nextTierFor(lifetimeProfit, config) {
  const { tiers } = normalizeConfig(config);
  const cur = tierFor(lifetimeProfit, config);
  const next = tiers[cur.index + 1];
  if (!next) return null;
  const remaining = Math.max(0, next.minLifetimeProfit - num(lifetimeProfit));
  const span = Math.max(1, next.minLifetimeProfit - cur.minLifetimeProfit);
  const done = Math.max(0, num(lifetimeProfit) - cur.minLifetimeProfit);
  return { ...next, remaining: round2(remaining), progress: Math.min(1, done / span) };
}

// How an order is attributed for pay purposes.
//   'self'          — the agent sourced the company; first order for it
//   'reorder'       — the agent sourced the company, and it has ordered before
//   'house'         — the owner sourced the lead; first order for it
//   'house_reorder' — the owner's lead, ordering again. Pays nothing by default
//                     ("house leads pay on the first order only"), because after
//                     that the account is the owner's to service.
// `priorOrdersForCompany` counts EARLIER orders for the same companyKey; the
// caller supplies it because only it knows the book.
function originKind({ sourcedByAgent, priorOrdersForCompany = 0 } = {}) {
  const repeat = num(priorOrdersForCompany) > 0;
  if (sourcedByAgent) return repeat ? 'reorder' : 'self';
  return repeat ? 'house_reorder' : 'house';
}

// The rate for one order, and the human reason for it. Returns pct plus the
// tier it came from, so a statement line can explain itself without the UI
// re-deriving anything.
function rateFor({ kind, lifetimeProfit = 0, selfOrdersCompleted = 0, config } = {}) {
  const cfg = normalizeConfig(config);
  const tier = tierFor(lifetimeProfit, cfg);

  if (kind === 'house_reorder') {
    // The owner's lead, ordering again — house accounts pay on the first order
    // only, unless the owner has explicitly opted into paying repeats.
    return cfg.houseReordersPay
      ? { pct: tier.housePct, tierName: tier.name, tierIndex: tier.index, basis: 'repeat house order' }
      : { pct: 0, tierName: tier.name, tierIndex: tier.index, basis: 'house account — first order only' };
  }
  if (kind === 'house') {
    return { pct: tier.housePct, tierName: tier.name, tierIndex: tier.index, basis: 'house lead' };
  }
  if (kind === 'reorder') {
    return { pct: tier.reorderPct, tierName: tier.name, tierIndex: tier.index, basis: 'reorder from your client' };
  }
  // self — fast start lifts the first N completed self-sourced orders to tier 2
  // (or the top tier, if the ladder is shorter than two rungs).
  const fastStartActive = cfg.fastStartOrders > 0 && num(selfOrdersCompleted) < cfg.fastStartOrders;
  if (fastStartActive) {
    const boost = cfg.tiers[Math.min(1, cfg.tiers.length - 1)];
    if (boost && boost.selfPct > tier.selfPct) {
      return { pct: boost.selfPct, tierName: boost.name, tierIndex: cfg.tiers.indexOf(boost), basis: 'fast start' };
    }
  }
  return { pct: tier.selfPct, tierName: tier.name, tierIndex: tier.index, basis: 'you found them' };
}

// Is this order's commission actually owed yet? Deliberately strict and in one
// place, because "earned" is the word with legal weight — New Jersey's sales-rep
// statute puts real teeth behind paying a rep what they have earned, so the app
// should never imply money is due earlier than the agreement says.
//   'pending'  — not delivered and paid yet; shown as a forecast, not a balance
//   'earned'   — delivered AND paid; owed
// `costIsEstimate` rides alongside: an earned order whose receipts the owner
// hasn't booked yet still shows a number, flagged as an estimate off the quote.
function earnedState(order) {
  const o = order || {};
  const delivered = o.status === 'delivered' || !!o.deliveredDate;
  const paid = !!o.paid;
  return delivered && paid ? 'earned' : 'pending';
}

// The whole calculation for ONE order. `profit` is gross profit BEFORE this
// agent's commission — the caller computes it with the canonical finance rule so
// the agent's statement and the owner's P&L reconcile to the cent.
function commissionForOrder({
  profit, kind, lifetimeProfit = 0, selfOrdersCompleted = 0, config, state = 'pending',
} = {}) {
  const rate = rateFor({ kind, lifetimeProfit, selfOrdersCompleted, config });
  // A loss-making or zero-profit order pays nothing — never a negative
  // commission, which would claw back pay for a job the owner chose to take at
  // cost to land a client. The agent keeps origination credit either way, so
  // every future reorder from that client still pays.
  const base = Math.max(0, num(profit));
  return {
    kind,
    state,
    ratePct: rate.pct,
    tierName: rate.tierName,
    tierIndex: rate.tierIndex,
    basis: rate.basis,
    profit: round2(profit),
    commission: round2(base * (rate.pct / 100)),
  };
}

module.exports = {
  DEFAULT_COMMISSION,
  normalizeConfig,
  tierFor,
  nextTierFor,
  originKind,
  rateFor,
  earnedState,
  commissionForOrder,
};
