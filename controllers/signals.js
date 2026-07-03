// controllers/signals.js
//
// GET /api/signals — the Studio hub's Smart Alerts feed. Thin HTTP wrapper over
// services/signals.buildSignals (which composes the existing order/finance/CRM/
// triage roll-ups into one severity-ranked payload). Studio-only (requireAdmin).

const { buildSignals } = require('../services/signals');

async function getSignals(req, res) {
  try {
    const data = await buildSignals({});
    res.json(data);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = { getSignals };
