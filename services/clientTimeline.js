// services/clientTimeline.js
//
// ONE STREAM PER CLIENT — "the states clients are in, from talking to the client
// to placing the order."
//
// The events already exist. They are just scattered across seven append-only
// logs that never meet: the CRM's own `Client.log[]`, `Order.activity[]` plus the
// order's date milestones, `PurchaseOrder.events[]`, the cold-email sends on
// `OutreachEnrollment`, inbound `TriageReply` rows, the original
// `ContactSubmission`, and the stops on a `FieldRun`. Ask "what has actually
// happened with this company" and you had to open five screens.
//
// WHY THIS MERGES AT READ TIME rather than writing to a new events collection:
// a write-only spine starts EMPTY. Every client on the books today would show
// nothing until something new happened to them, which is the opposite of useful
// for a business that has been running for years. Merging what is already stored
// gives the full history from the first load, needs no migration, and cannot
// desynchronise from the sources because it has no copy to desynchronise.
//
// The event shape below is deliberately the shape a materialised collection
// would store, so if volume ever justifies one, it becomes a cache of this
// function rather than a redesign.
//
// Everything here is PURE — it takes already-fetched documents and returns
// events. The queries live in the controller.

// The arc a client travels. Ordering matters: it is how the UI groups a stream
// into phases, and how `currentPhase` decides how far along someone is.
const PHASES = ['inbound', 'outreach', 'conversation', 'quote', 'order', 'aftercare'];

// kind → { phase, label }. One place, so a new event type can't be invented
// twice with two different names.
const KINDS = {
  submission:      { phase: 'inbound',      label: 'Contact form' },
  outreach_sent:   { phase: 'outreach',     label: 'Cold email sent' },
  outreach_opened: { phase: 'outreach',     label: 'Cold email opened' },
  reply:           { phase: 'conversation', label: 'They replied' },
  call:            { phase: 'conversation', label: 'Call' },
  text:            { phase: 'conversation', label: 'Text' },
  email:           { phase: 'conversation', label: 'Email' },
  visit:           { phase: 'conversation', label: 'Visit' },
  note:            { phase: 'conversation', label: 'Note' },
  field_visit:     { phase: 'conversation', label: 'Field stop' },
  stage:           { phase: 'conversation', label: 'Stage change' },
  quote_activity:  { phase: 'quote',        label: 'Quote' },
  order_created:   { phase: 'quote',        label: 'Project opened' },
  order_placed:    { phase: 'order',        label: 'Order placed' },
  po_event:        { phase: 'order',        label: 'Purchase order' },
  shipped:         { phase: 'order',        label: 'Shipped' },
  delivered:       { phase: 'order',        label: 'Delivered' },
  closeout:        { phase: 'aftercare',    label: 'Closed out' },
};

const at = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const ev = (kind, when, title, extra = {}) => {
  const when2 = at(when);
  if (!when2) return null;   // an event with no time can't sit on a timeline
  const spec = KINDS[kind] || { phase: 'conversation', label: kind };
  return {
    at: when2, kind, phase: spec.phase, label: spec.label,
    title: String(title || spec.label),
    detail: '', actor: '', orderNumber: '', projectNumber: '', ...extra,
  };
};

// The CRM's own touch log — the owner's calls, texts, visits and notes.
function fromClientLog(client) {
  const rows = (client && Array.isArray(client.log)) ? client.log : [];
  return rows.map((l) => {
    if (!l) return null;
    const kind = KINDS[l.kind] ? l.kind : 'note';
    return ev(kind, l.at, l.text || (KINDS[kind] || {}).label, { actor: l.by || '', detail: '' });
  }).filter(Boolean);
}

// One order: its own activity feed plus the milestones that live as plain dates
// on the document (which no activity entry ever records).
function fromOrder(order) {
  if (!order) return [];
  const tag = { orderNumber: order.orderNumber || '', projectNumber: order.projectNumber || '' };
  const out = [];

  out.push(ev('order_created', order.createdAt, `Project ${order.projectNumber || ''} opened`.trim(), tag));

  for (const a of (Array.isArray(order.activity) ? order.activity : [])) {
    if (!a) continue;
    // The activity feed already carries a kind; map the money/quote ones into the
    // quote phase and leave the rest as conversation-level notes.
    out.push(ev('quote_activity', a.at, a.message || a.kind || 'Activity',
      { ...tag, actor: a.actor || '', detail: a.kind || '' }));
  }

  if (order.orderNumber && order.orderDate) {
    out.push(ev('order_placed', order.orderDate,
      `Order ${order.orderNumber} placed${order.totalValue ? ` · $${Math.round(order.totalValue).toLocaleString()}` : ''}`, tag));
  }
  out.push(ev('shipped', order.shipDate, 'Shipped', tag));
  out.push(ev('delivered', order.deliveredDate, 'Delivered', tag));

  const c = order.closeout;
  if (c && c.at) {
    const bits = [];
    if (c.rating) bits.push(`${c.rating}/5`);
    if (c.onTime === true) bits.push('on time');
    if (c.onTime === false) bits.push('late');
    if (c.reprintQty) bits.push(`${c.reprintQty} reprinted`);
    out.push(ev('closeout', c.at, 'Closed out', { ...tag, detail: bits.join(' · ') }));
  }
  return out.filter(Boolean);
}

// Purchase orders hanging off this client's orders.
function fromPurchaseOrders(pos) {
  const out = [];
  for (const po of (Array.isArray(pos) ? pos : [])) {
    if (!po) continue;
    for (const e of (Array.isArray(po.events) ? po.events : [])) {
      if (!e) continue;
      out.push(ev('po_event', e.at, `PO ${po.poNumber || ''} · ${e.kind || 'updated'}`.trim(),
        { detail: po.vendorKey || '', orderNumber: po.orderNumber || '' }));
    }
  }
  return out.filter(Boolean);
}

// Cold outreach: what we sent, and whether they opened it. The open is a separate
// event because it happened at a different time and means something different.
function fromOutreach(enrollments) {
  const out = [];
  for (const e of (Array.isArray(enrollments) ? enrollments : [])) {
    for (const s of (e && Array.isArray(e.sends) ? e.sends : [])) {
      if (!s) continue;
      out.push(ev('outreach_sent', s.at, `Cold email · step ${(s.stepIndex || 0) + 1}`,
        { detail: e.toEmail || '' }));
      if (s.openedAt) out.push(ev('outreach_opened', s.openedAt, 'Opened the cold email', { detail: e.toEmail || '' }));
    }
  }
  return out.filter(Boolean);
}

// Inbound replies — the moment a cold lead became a conversation.
function fromReplies(replies) {
  return (Array.isArray(replies) ? replies : []).map((r) => (r ? ev(
    'reply', r.receivedAt || r.createdAt, r.subject || 'Replied',
    { actor: r.fromName || r.fromEmail || '', detail: r.category || '' },
  ) : null)).filter(Boolean);
}

// The contact form that started it all.
function fromSubmissions(subs) {
  return (Array.isArray(subs) ? subs : []).map((s) => {
    if (!s) return null;
    const bits = [s.quantity ? `${s.quantity} units` : '', s.inHandDate ? `needs ${s.inHandDate}` : '']
      .filter(Boolean).join(' · ');
    return ev('submission', s.createdAt, `Contact form${s.source ? ` · ${s.source}` : ''}`,
      { actor: s.name || '', detail: bits });
  }).filter(Boolean);
}

// Road-trip stops that reached this company.
function fromFieldRuns(runs, companyKey) {
  const out = [];
  for (const r of (Array.isArray(runs) ? runs : [])) {
    for (const st of (r && Array.isArray(r.stops) ? r.stops : [])) {
      if (!st || (companyKey && st.companyKey !== companyKey)) continue;
      if (!st.visitedAt) continue;
      out.push(ev('field_visit', st.visitedAt, `Stopped by ${st.name || 'the shop'}`,
        { detail: st.outcome || '' }));
    }
  }
  return out.filter(Boolean);
}

// Two sources can describe the same real-world moment — a logged "emailed them"
// beside the outreach send that produced it. Collapse on the same phase within
// the same minute with the same title, keeping the RICHER row (more detail).
function dedupe(events) {
  const seen = new Map();
  for (const e of events) {
    const key = `${e.kind}|${Math.floor(e.at.getTime() / 60000)}|${e.title}`;
    const prev = seen.get(key);
    if (!prev || (e.detail || '').length > (prev.detail || '').length) seen.set(key, e);
  }
  return [...seen.values()];
}

// The whole stream, newest first.
function mergeTimeline(...groups) {
  const all = groups.flat().filter((e) => e && e.at instanceof Date);
  return dedupe(all).sort((a, b) => b.at - a.at);
}

// What the header says: where they are, how long they've been there, and the
// shape of the relationship. Never guesses — a field it can't answer is null.
function summarize(events) {
  if (!events.length) {
    return { firstTouch: null, lastTouch: null, daysSinceLastTouch: null, currentPhase: null, counts: {}, phaseCounts: {} };
  }
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const counts = {};
  const phaseCounts = {};
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] || 0) + 1;
    phaseCounts[e.phase] = (phaseCounts[e.phase] || 0) + 1;
  }
  // Furthest phase reached, not the most recent event's phase — a note logged
  // after delivery doesn't move a client back to "conversation".
  let currentPhase = null;
  for (const p of PHASES) if (phaseCounts[p]) currentPhase = p;
  const lastTouch = sorted[sorted.length - 1].at;
  return {
    firstTouch: sorted[0].at,
    lastTouch,
    daysSinceLastTouch: Math.floor((Date.now() - lastTouch.getTime()) / 86400000),
    currentPhase,
    counts,
    phaseCounts,
  };
}

module.exports = {
  PHASES, KINDS,
  fromClientLog, fromOrder, fromPurchaseOrders, fromOutreach, fromReplies,
  fromSubmissions, fromFieldRuns,
  mergeTimeline, summarize,
  _dedupe: dedupe, _ev: ev,
};
