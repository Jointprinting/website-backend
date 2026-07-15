// controllers/preorders.js
//
// Preorder links v1 — owner mints an expiring public link; the client's
// people commit to quantities (commitments, NOT payments). Owner side rides
// the usual admin auth; the public side is token-gated exactly like the
// approval page and lookbooks, and its payload is built the same way: only
// what the visitor needs — labels, sizes, open/closed — never contacts,
// never other people's details, never anything priced.

const crypto = require('crypto');
const PreorderLink = require('../models/PreorderLink');
const Order = require('../models/Order');
const ClientLogo = require('../models/ClientLogo');

const MAX_ITEMS = 20;
const MAX_QTY = 10000;
const DEFAULT_EXPIRES_DAYS = 14;

const MAX_VARIANTS = 6;   // owner pitches ~3 brands per design; leave headroom
const money2 = (v) => Math.max(0, Math.round((Number(v) || 0) * 100) / 100);

const _cleanItems = (items) => (Array.isArray(items) ? items : [])
  .map((it) => ({
    id: String((it && it.id) || '') || crypto.randomBytes(4).toString('hex'),
    label: String((it && it.label) || '').trim().slice(0, 120),
    sizes: (Array.isArray(it && it.sizes) ? it.sizes : [])
      .map((s) => String(s || '').trim().slice(0, 12)).filter(Boolean).slice(0, 12),
    // Brand options the customer chooses between — each with its own customer
    // price (the client's tier + markup collapsed to one per-unit price) and its
    // garment colors. Empty = a legacy item (label + sizes, no priced choice).
    variants: (Array.isArray(it && it.variants) ? it.variants : [])
      .map((v) => ({
        id: String((v && v.id) || '') || crypto.randomBytes(4).toString('hex'),
        name: String((v && v.name) || '').trim().slice(0, 60),
        price: money2(v && v.price),
        colors: (Array.isArray(v && v.colors) ? v.colors : [])
          .map((c) => String(c || '').trim().slice(0, 40)).filter(Boolean).slice(0, 24),
      }))
      .filter((v) => v.name)
      .slice(0, MAX_VARIANTS),
  }))
  .filter((it) => it.label)
  .slice(0, MAX_ITEMS);

// What the PUBLIC is allowed to see of the tally. Owner's FOMO rule: when a drop
// carries a MOQ, the running count stays HIDDEN until the drop PASSES it — an
// empty/low bar reads as unpopular, a full one is social proof — then it reveals
// (with the goal) as a "it's happening" progress bar. With no MOQ (0) it's a plain
// open tally shown as-is. The OWNER side never uses this (it always sees the full
// tally + moq via listPreorders). Pure — unit-tested.
function publicProgress(link, t) {
  const moq = Math.max(0, Number(link && link.moq) || 0);
  const totalQty = (t && t.totalQty) || 0;
  const people = (t && t.people) || 0;
  const reached = moq > 0 ? totalQty >= moq : true;
  const reveal = moq === 0 ? people > 0 : reached;      // show numbers to the public?
  return {
    moqReached: moq > 0 && reached,
    moq: (moq > 0 && reached) ? moq : undefined,         // reveal the goal only once it's hit
    tally: reveal ? { people, totalQty } : { people: 0, totalQty: 0 },
  };
}

// Rollup used by both sides: how many people, how many units, per-item/size.
// Public gets the totals; the owner ALSO gets the per-row breakdown.
function tally(commitments) {
  const rows = Array.isArray(commitments) ? commitments : [];
  const people = new Set(rows.map((c) => `${c.name}`.trim().toLowerCase())).size;
  const totalQty = rows.reduce((t, c) => t + (Number(c.qty) || 0), 0);
  // Committed revenue = Σ qty × the price snapshot each commitment carries. 0 for
  // legacy/un-priced drops (unitPrice defaults to 0), so old drops are unchanged.
  const revenue = money2(rows.reduce((t, c) => t + (Number(c.qty) || 0) * (Number(c.unitPrice) || 0), 0));
  const byItem = {};
  for (const c of rows) {
    const k = c.itemId;
    if (!byItem[k]) byItem[k] = { qty: 0, revenue: 0, bySize: {}, byVariant: {} };
    const q = Number(c.qty) || 0;
    byItem[k].qty += q;
    byItem[k].revenue = money2(byItem[k].revenue + q * (Number(c.unitPrice) || 0));
    const sz = c.size || '—';
    byItem[k].bySize[sz] = (byItem[k].bySize[sz] || 0) + q;
    if (c.variant) {
      const vk = c.color ? `${c.variant} · ${c.color}` : c.variant;
      byItem[k].byVariant[vk] = (byItem[k].byVariant[vk] || 0) + q;
    }
  }
  return { people, totalQty, revenue, byItem };
}

// POST /api/preorders — mint. Body: { title, note, items, companyKey,
// orderId, expiresDays } (expiresDays 0/null = no expiry).
async function createPreorder(req, res) {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 140);
    if (!title) return res.status(400).json({ message: 'Give the preorder a title.' });
    const items = _cleanItems(b.items);
    if (!items.length) return res.status(400).json({ message: 'Add at least one item to commit to.' });

    // Anchor to the project when given — the tally shows up on that order and
    // the link inherits its companyKey so CRM sees it too.
    let orderId = null; let projectNumber = ''; let companyKey = String(b.companyKey || '').trim();
    if (b.orderId) {
      const o = await Order.findById(b.orderId).select('projectNumber companyKey').lean();
      if (o) { orderId = o._id; projectNumber = o.projectNumber || ''; companyKey = companyKey || o.companyKey || ''; }
    }

    const days = b.expiresDays === 0 || b.expiresDays === null ? 0 : Number(b.expiresDays) || DEFAULT_EXPIRES_DAYS;
    const link = await PreorderLink.create({
      token: crypto.randomBytes(12).toString('hex'),
      clientToken: crypto.randomBytes(12).toString('hex'),
      companyKey, projectNumber, orderId,
      title, note: String(b.note || '').trim().slice(0, 600),
      pickupLocation: String(b.pickupLocation || '').trim().slice(0, 200),
      items,
      moq: Math.max(0, Math.round(Number(b.moq) || 0)),
      expiresAt: days > 0 ? new Date(Date.now() + days * 86400000) : null,
    });
    res.status(201).json({ preorder: link.toObject() });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// GET /api/preorders?orderId=&companyKey= — owner list, newest first, with
// the tallies computed server-side so the Studio never sums rows itself.
async function listPreorders(req, res) {
  try {
    const cond = {};
    if (req.query.orderId) cond.orderId = req.query.orderId;
    if (req.query.companyKey) cond.companyKey = String(req.query.companyKey);
    const links = await PreorderLink.find(cond).sort({ createdAt: -1 }).limit(200).lean();
    // Lazily mint a clientToken for links created before the two-door split, so
    // every drop the owner sees has a client link to send. Cheap, idempotent.
    const missing = links.filter((l) => !l.clientToken);
    await Promise.all(missing.map((l) => {
      l.clientToken = crypto.randomBytes(12).toString('hex');
      return PreorderLink.updateOne({ _id: l._id }, { $set: { clientToken: l.clientToken } });
    }));
    res.json({
      preorders: links.map((l) => ({
        ...l,
        open: !l.revokedAt && !(l.expiresAt && new Date(l.expiresAt).getTime() < Date.now()),
        tally: tally(l.commitments),
      })),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// PATCH /api/preorders/:id — revoke/reopen/extend. No deletes (house rule):
// a closed link keeps its commitments as the record of the drop.
async function updatePreorder(req, res) {
  try {
    const b = req.body || {};
    const set = {};
    if (b.revoke === true) set.revokedAt = new Date();
    if (b.revoke === false) set.revokedAt = null;
    if (b.expiresDays !== undefined) {
      const days = Number(b.expiresDays) || 0;
      set.expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;
    }
    if (b.title !== undefined) set.title = String(b.title || '').trim().slice(0, 140);
    if (b.note !== undefined) set.note = String(b.note || '').trim().slice(0, 600);
    if (b.pickupLocation !== undefined) set.pickupLocation = String(b.pickupLocation || '').trim().slice(0, 200);
    if (b.moq !== undefined) set.moq = Math.max(0, Math.round(Number(b.moq) || 0));
    if (!Object.keys(set).length) return res.status(400).json({ message: 'Nothing to update.' });
    const link = await PreorderLink.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!link) return res.status(404).json({ message: 'Preorder not found.' });
    res.json({ preorder: { ...link, tally: tally(link.commitments) } });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// ── Public (token-gated, no auth) ───────────────────────────────────────────

// GET /api/preorder/:token — the page payload. Totals only; no names, no
// contacts, nothing from other people's commitments.
async function getPublicPreorder(req, res) {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(404).json({ message: 'This link is invalid.', reason: 'invalid' });
    const link = await PreorderLink.findOne({ token });
    if (!link) return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    const logo = link.companyKey
      ? await ClientLogo.findOne({ companyKey: link.companyKey }).select('imageDataUrl').lean()
      : null;
    const pub = publicProgress(link, tally(link.commitments));
    res.json({
      title: link.title,
      note: link.note,
      pickupLocation: link.pickupLocation || '',
      items: link.items.map((it) => ({
        id: it.id, label: it.label, sizes: it.sizes,
        variants: (it.variants || []).map((v) => ({ id: v.id, name: v.name, price: v.price, colors: v.colors })),
      })),
      logo: logo ? logo.imageDataUrl : null,
      open: link.isOpen(),
      expiresAt: link.expiresAt,
      moq: pub.moq,               // the goal — only sent once the drop has hit it
      moqReached: pub.moqReached,
      tally: pub.tally,           // hidden (zeros) until MOQ is passed
    });
  } catch (e) {
    console.error('[preorder] public read failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
  }
}

// POST /api/preorder/:token/commit — one person's commitment. Body:
// { name, contact, note, entries: [{ itemId, size, qty }] }.
async function commitPreorder(req, res) {
  try {
    const token = String(req.params.token || '').trim();
    const link = await PreorderLink.findOne({ token });
    if (!link) return res.status(404).json({ message: 'This link is invalid or no longer available.' });
    if (!link.isOpen()) return res.status(410).json({ message: 'This preorder is closed — reach out to your contact if you still need in.' });

    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ message: 'Add your name so the order knows who this is for.' });
    const contact = String(b.contact || '').trim().slice(0, 120);
    const note = String(b.note || '').trim().slice(0, 300);
    const byId = new Map(link.items.map((it) => [it.id, it]));
    const entries = (Array.isArray(b.entries) ? b.entries : [])
      .map((e) => ({
        itemId: String((e && e.itemId) || ''),
        variantId: String((e && e.variantId) || ''),
        color: String((e && e.color) || '').trim().slice(0, 40),
        size: String((e && e.size) || '').trim().slice(0, 12),
        qty: Math.min(Math.max(Math.round(Number(e && e.qty) || 0), 0), MAX_QTY),
      }))
      .filter((e) => e.qty > 0 && byId.has(e.itemId))
      .map((e) => {
        const it = byId.get(e.itemId);
        const variants = it.variants || [];
        // Resolve the chosen brand: a single-variant item auto-selects; a
        // multi-variant item must match a real one (else the entry can't be priced).
        let v = null;
        if (variants.length === 1) v = variants[0];
        else if (variants.length > 1) v = variants.find((x) => x.id === e.variantId) || null;
        if (variants.length && !v) return null;
        // Size / color only count when the item / brand actually offers them.
        const size = (it.sizes || []).includes(e.size) ? e.size : '';
        const color = v && (v.colors || []).includes(e.color) ? e.color : '';
        return { itemId: e.itemId, variant: v ? v.name : '', color, size, qty: e.qty, unitPrice: v ? (Number(v.price) || 0) : 0 };
      })
      .filter(Boolean)
      .slice(0, 40);
    if (!entries.length) return res.status(400).json({ message: 'Pick at least one quantity (and a brand where the item offers a choice).' });

    link.commitments.push(...entries.map((e) => ({ name, contact, note, ...e })));
    await link.save();

    // Ecosystem: the linked project hears about it in its activity feed.
    if (link.orderId) {
      const units = entries.reduce((t, e) => t + e.qty, 0);
      await Order.updateOne(
        { _id: link.orderId },
        { $push: { activity: {
          kind: 'preorder_commit', actor: 'client',
          message: `Preorder "${link.title}": ${name} committed ${units} unit${units === 1 ? '' : 's'}`,
          meta: { preorderId: String(link._id), name, units },
          at: new Date(),
        } } },
      ).catch(() => {});
    }

    const pub = publicProgress(link, tally(link.commitments));
    res.status(201).json({ ok: true, moq: pub.moq, moqReached: pub.moqReached, tally: pub.tally });
  } catch (e) {
    console.error('[preorder] commit failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
  }
}

// GET /api/preorder/client/:clientToken — the CLIENT/organizer view. Unlike the
// customer page, the organizer sees FULL progress at all times (they're running
// the drop, the FOMO hiding doesn't apply to them) plus the customer token to
// share. Still read-only + token-gated — no owner auth, no commitment editing.
async function getClientPreorder(req, res) {
  try {
    const clientToken = String(req.params.clientToken || '').trim();
    if (!clientToken) return res.status(404).json({ message: 'This link is invalid.', reason: 'invalid' });
    const link = await PreorderLink.findOne({ clientToken });
    if (!link) return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    const logo = link.companyKey
      ? await ClientLogo.findOne({ companyKey: link.companyKey }).select('imageDataUrl').lean()
      : null;
    const t = tally(link.commitments);
    res.json({
      title: link.title,
      note: link.note,
      pickupLocation: link.pickupLocation || '',
      items: link.items.map((it) => ({
        id: it.id, label: it.label, sizes: it.sizes,
        variants: (it.variants || []).map((v) => ({ id: v.id, name: v.name, price: v.price, colors: v.colors })),
      })),
      logo: logo ? logo.imageDataUrl : null,
      open: link.isOpen(),
      expiresAt: link.expiresAt,
      moq: link.moq || 0,
      customerToken: link.token,                 // the link the organizer shares with their people
      // Full breakdown — the organizer sees everything, MOQ or not.
      tally: { people: t.people, totalQty: t.totalQty, revenue: t.revenue, byItem: t.byItem },
      moqReached: link.moq > 0 ? t.totalQty >= link.moq : false,
    });
  } catch (e) {
    console.error('[preorder] client read failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
  }
}

module.exports = {
  createPreorder, listPreorders, updatePreorder,
  getPublicPreorder, commitPreorder, getClientPreorder,
  _tally: tally, _cleanItems, _publicProgress: publicProgress,
};
