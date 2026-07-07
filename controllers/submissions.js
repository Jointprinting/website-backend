// controllers/submissions.js
//
// Studio-only CRUD for contact form submissions (mini-CRM).
// All endpoints here require requireAdmin middleware in the routes file.

const ContactSubmission = require('../models/ContactSubmission');

const ALLOWED_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost', 'spam'];

/**
 * GET /api/submissions
 * Optional query params:
 *   - status: filter by lifecycle status
 *   - includeBots: '1' to include honeypot=true rows (default: hide them)
 *   - limit: max rows (default 200, max 500)
 */
exports.listSubmissions = async (req, res) => {
  try {
    const { status, includeBots } = req.query;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

    const query = {};
    if (status && ALLOWED_STATUSES.includes(status)) query.status = status;
    if (includeBots !== '1') query.honeypot = { $ne: true };

    const submissions = await ContactSubmission
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ submissions, count: submissions.length });
  } catch (err) {
    console.error('listSubmissions error:', err);
    return res.status(500).json({ message: 'Failed to load submissions' });
  }
};

exports.getSubmission = async (req, res) => {
  try {
    const submission = await ContactSubmission.findById(req.params.id).lean();
    if (!submission) return res.status(404).json({ message: 'Not found' });
    return res.json({ submission });
  } catch (err) {
    return res.status(400).json({ message: 'Invalid ID' });
  }
};

/**
 * PATCH /api/submissions/:id
 * Body: { status?, notesAdmin? }
 */
exports.updateSubmission = async (req, res) => {
  try {
    const updates = {};
    if (typeof req.body.status === 'string') {
      if (!ALLOWED_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ message: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
      }
      updates.status = req.body.status;
    }
    if (typeof req.body.notesAdmin === 'string') {
      updates.notesAdmin = req.body.notesAdmin.slice(0, 10000);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }
    updates.updatedAt = new Date();

    const submission = await ContactSubmission.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true }
    ).lean();

    if (!submission) return res.status(404).json({ message: 'Not found' });
    return res.json({ submission });
  } catch (err) {
    console.error('updateSubmission error:', err);
    return res.status(400).json({ message: err.message || 'Update failed' });
  }
};

exports.deleteSubmission = async (req, res) => {
  try {
    const result = await ContactSubmission.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ message: 'Not found' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ message: 'Invalid ID' });
  }
};

exports.getUnseenCount = async (_req, res) => {
  try {
    const count = await ContactSubmission.countDocuments({
      status: 'new', seenByAdmin: { $ne: true }, honeypot: { $ne: true },
    });
    return res.json({ count });
  } catch (err) {
    return res.status(500).json({ count: 0 });
  }
};

exports.markAllSeen = async (req, res) => {
  try {
    // Optional source scope: the Studio's JP Webworks "Inquiries" tile opens a
    // webworks-filtered view, so it must only mark THOSE seen — otherwise
    // opening it silently wipes the unseen state of contact-form leads the
    // owner never looked at. No/invalid source → original mark-everything.
    const source = (req.body && req.body.source) || (req.query && req.query.source) || '';
    const filter = { seenByAdmin: { $ne: true } };
    if (['contact', 'webworks'].includes(source)) filter.source = source;
    await ContactSubmission.updateMany(filter, { $set: { seenByAdmin: true } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: 'Failed' });
  }
};
