// controllers/portal.js
//
// The CLIENT PORTAL — one magic link per company (/portal/<token>) showing
// every order's status, the client-facing tracking timeline, and deep links
// into the live approval pages (which carry the full detail: options,
// confirmation, invoice/receipt PDFs). View-only by design: reordering is a
// conversation in v1, not a button.
//
// SAFETY: anyone with the link can read the raw JSON, so the payload is built
// like the approval page's — nothing internal ever rides along. Only fields
// the client-facing surfaces already show: numbers/status, PUBLISH-GATED
// totals (same _confPublished/_hasConfContent rules as the approval page),
// visible tracking steps, and one confirmation-referenced design thumbnail.
// Never: costs, margins, supplier names, or CRM internals (notes/log/contacts/
// stage/deal values). Tokens are long-lived and revocable — revoke CLEARS the
// token so a leaked URL dies right here at the lookup.

const Client = require('../models/Client');
const Order = require('../models/Order');
const ClientLogo = require('../models/ClientLogo');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const { mockupProjectNumber } = require('../utils/mockupScope');

const norm = (n) => String(n || '').replace(/^#/, '').replace(/^0+/, '').toUpperCase();

// GET /api/portal/:token — public, token-gated.
async function getPortal(req, res) {
  try {
    // ── HALTED (owner, 2026-07-14) ──────────────────────────────────────────
    // A magic link is bearer access: forwarded once, a third party can read
    // the client's order totals. The portal stays dark until it sits behind a
    // real sign-in (Google, v2). Existing minted links die right here. Flip
    // PORTAL_ENABLED=true on the API host only when the owner re-approves.
    if (process.env.PORTAL_ENABLED !== 'true') {
      return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    }
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(404).json({ message: 'This link is invalid.', reason: 'invalid' });
    const client = await Client.findOne({ portalToken: token })
      .select('companyKey companyName clientName portalRevokedAt archived').lean();
    if (!client || client.portalRevokedAt || client.archived) {
      return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    }

    // Publish-gate primitives shared with the approval page — a draft
    // confirmation's numbers must never show here either.
    const { _confPublished, _hasConfContent } = require('./approval');

    // Company-scoped ONLY by exact companyKey (never fuzzy matchKey) — the
    // token holder sees this one company's orders and nothing else.
    const orders = await Order.find({ companyKey: client.companyKey, archived: { $ne: true } })
      .select('projectNumber orderNumber status totalValue orderDate deliveredDate quoteLines confirmation mockupNumbers tracking approvalToken approvalTokenExpiresAt updatedAt')
      .sort({ orderDate: -1, updatedAt: -1 })
      .lean();

    // One design thumbnail per order: the first confirmation-referenced mockup,
    // else one from THAT order's own project. Same reference rule the approval
    // page uses — never the whole library, and never another project's work.
    // Scoped to this one company by indexed query (the token holder's company),
    // which is also all this handler could ever legitimately show.
    const mockupItems = await StudioLibraryItem
      .find({ store: 'mockups', companyKey: client.companyKey })
      .select('name pageState.mockupNum pageState.projectNumber projectNumber thumbnail').lean();
    const byNorm = {};
    const byProject = new Map();
    for (const m of mockupItems) {
      const k = norm(m.pageState && m.pageState.mockupNum);
      if (k && !byNorm[k]) byNorm[k] = m;
      const nk = norm(m.name);
      if (nk && !byNorm[nk]) byNorm[nk] = m;
      // Read the project link the same way every other surface does (field, else
      // the pageState blob it gets promoted from) — otherwise an order whose only
      // designs came in unpromoted shows a card with no thumbnail at all.
      const pn = mockupProjectNumber(m);
      if (pn && !byProject.has(pn)) byProject.set(pn, m);
    }

    const now = Date.now();
    const cards = [];
    for (const o of orders) {
      const confItems = (o.confirmation && o.confirmation.items) || [];
      const refs = confItems.map((it) => it && it.mockupNum).filter(Boolean);
      // No confirmation yet → this order's OWN project, not the client's whole
      // back catalogue (order.mockupNumbers had been accumulating every mockup
      // the client ever had — see the approval page for the full note).
      const firstMock = refs.length
        ? refs.map((n) => byNorm[norm(n)]).find(Boolean)
        : byProject.get(String(o.projectNumber || ''));

      // Publish gate on the money — mirrors publicGetProject exactly.
      const published = _confPublished(o.confirmation);
      const draftHidden = !published && _hasConfContent(o.confirmation);
      const totalValue = draftHidden
        ? Order.computeQuoteTotals(o.quoteLines || []).totalValue
        : o.totalValue;

      const steps = ((o.tracking && o.tracking.steps) || [])
        .filter((s) => !s.hidden)
        .map((s) => ({ id: s.id, label: s.label, completedAt: s.completedAt || null, note: s.note || '', link: s.link || '' }));
      const paid = steps.some((s) => s.id === 'order_paid' && s.completedAt);
      const approved = steps.some((s) => s.id === 'confirmation_approved' && s.completedAt);

      // The order's own approval link (same token the share email used). An
      // approved order's page stays reachable through the grace machinery, so
      // count it live; an expired never-approved link just isn't shown.
      const approvalLive = !!o.approvalToken
        && (approved || !o.approvalTokenExpiresAt || new Date(o.approvalTokenExpiresAt).getTime() > now);

      // Skip empty shells (a minted project with nothing on it yet) — a card
      // with no money, no link, and no progress only confuses the client.
      const anyProgress = steps.some((s) => s.completedAt);
      if (!(Number(totalValue) > 0) && !approvalLive && !anyProgress) continue;

      const names = (published && confItems.length
        ? confItems.map((it) => it && it.description)
        : (o.quoteLines || []).filter((l) => l && l.accepted).map((l) => l.description))
        .filter(Boolean);

      cards.push({
        id: String(o._id),
        projectNumber: o.projectNumber || '',
        orderNumber: o.orderNumber || '',
        status: o.status,
        orderDate: draftHidden ? null : (o.orderDate || null),
        deliveredDate: o.deliveredDate || null,
        totalValue,
        paid,
        approved,
        summary: [...new Set(names)].slice(0, 3).join(' · '),
        thumbnail: (firstMock && firstMock.thumbnail) || '',
        tracking: { steps },
        approvalLive,
        approvalToken: approvalLive ? o.approvalToken : '',
      });
    }

    const logo = await ClientLogo.findOne({ companyKey: client.companyKey }).select('imageDataUrl').lean();

    res.json({
      company: {
        companyName: client.companyName || client.clientName || '',
        logo: logo ? logo.imageDataUrl : null,
      },
      orders: cards,
    });
  } catch (e) {
    console.error('[portal] public handler failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
  }
}

module.exports = { getPortal };
