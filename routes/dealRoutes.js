// routes/dealRoutes.js — the deal pipeline (CRM). Admin-only.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listDeals, createDeal, updateDeal, deleteDeal, winDeal, loseDeal,
  migrateFromOrders, rollbackMigration, migrationStatus, startJob,
} = require('../controllers/deals');

router.use(requireAdmin);

// Reversible "set up deals from my orders" migration. Static paths first so
// "migrate" is never swallowed as a :id.
router.get('/migrate/status',    migrationStatus);
router.post('/migrate',          migrateFromOrders);   // { dryRun } to preview
router.post('/migrate/rollback', rollbackMigration);   // { batchId } to undo

// One-tap "Start new job": project + deal card in one go (STATIC, above /:id).
router.post('/start-job',        startJob);

// CRUD + close actions.
router.get('/',           listDeals);
router.post('/',          createDeal);
router.put('/:id',        updateDeal);
router.delete('/:id',     deleteDeal);
router.post('/:id/win',   winDeal);
router.post('/:id/lose',  loseDeal);

module.exports = router;
