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

const _cleanItems = (items) => (Array.isArray(items) ? items : [])
  .map((it) => ({
    id: String((it && it.id) || '') || crypto.randomBytes(4).toString('hex'),
    label: String((it && it.label) || '').trim().slice(0, 120),
    sizes: (Array.isArray(it && it.sizes) ? it.sizes : [])
      .map((s) => String(s || '').trim().slice(0, 12)).filter(Boolean).slice(0, 12),
  }))
  .filter((it) => it.label)
  .slice(0, MAX_ITEMS);

// Rollup used by both sides: how many people, how many units, per-item/size.
// Public gets the totals; the owner ALSO gets the per-row breakdown.
function tally(commitments) {
  const rows = Array.isArray(commitments) ? commitments : [];
  const people = new Set(rows.map((c) => `${c.name}`.trim().toLowerCase())).size;
  const totalQty = rows.reduce((t, c) => t + (Number(c.qty) || 0), 0);
  const byItem = {};
  for (const c of rows) {
    const k = c.itemId;
    if (!byItem[k]) byItem[k] = { qty: 0, bySize: {} };
    byItem[k].qty += Number(c.qty) || 0;
    const sz = c.size || '—';
    byItem[k].bySize[sz] = (byItem[k].bySize[sz] || 0) + (Number(c.qty) || 0);
  }
  return { people, totalQty, byItem };
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
      companyKey, projectNumber, orderId,
      title, note: String(b.note || '').trim().slice(0, 600),
      items,
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
    const t = tally(link.commitments);
    res.json({
      title: link.title,
      note: link.note,
      items: link.items.map((it) => ({ id: it.id, label: it.label, sizes: it.sizes })),
      logo: logo ? logo.imageDataUrl : null,
      open: link.isOpen(),
      expiresAt: link.expiresAt,
      tally: { people: t.people, totalQty: t.totalQty },
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
        size: String((e && e.size) || '').trim().slice(0, 12),
        qty: Math.min(Math.max(Math.round(Number(e && e.qty) || 0), 0), MAX_QTY),
      }))
      .filter((e) => e.qty > 0 && byId.has(e.itemId))
      // A size is only meaningful when the item actually offers it.
      .map((e) => ({ ...e, size: (byId.get(e.itemId).sizes || []).includes(e.size) ? e.size : '' }))
      .slice(0, 40);
    if (!entries.length) return res.status(400).json({ message: 'Pick at least one quantity.' });

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

    const t = tally(link.commitments);
    res.status(201).json({ ok: true, tally: { people: t.people, totalQty: t.totalQty } });
  } catch (e) {
    console.error('[preorder] commit failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
  }
}

module.exports = {
  createPreorder, listPreorders, updatePreorder,
  getPublicPreorder, commitPreorder,
  _tally: tally, _cleanItems,
};
