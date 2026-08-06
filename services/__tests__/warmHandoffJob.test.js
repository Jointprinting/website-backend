// services/__tests__/warmHandoffJob.test.js
//
// The good ending: a lead replied, the owner said "start the job", and the
// company has to stop being a prospect in every place it can still act like one.
//
// The pieces of this handoff all existed separately — the CRM's "Start new job"
// minted a project and a deal card, and the outreach engine kept its own
// enrollment state — but nothing ran them together. Converting a lead by hand
// left its sequence ACTIVE, so a shop the owner was actively quoting kept
// getting cold touch 3. That's the regression these tests exist to prevent.
//
//   node --test services/__tests__/warmHandoffJob.test.js
//
// convertToJob writes through Mongoose, so the models and the orders controller
// are stubbed in the require cache and the calls are recorded.

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = { project: [], deal: [], closeWarm: [], clientUpdate: [] };
let clientDoc = null;

function stub(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../../controllers/crm', { promoteStage: (from, to) => to });
stub('../../models/OutreachCampaign', { findById: () => ({ select: () => ({ lean: async () => null }) }) });
stub('../../models/Client', {
  findOne: () => ({ select: () => ({ lean: async () => clientDoc }) }),
  updateOne: async (filter, update) => { calls.clientUpdate.push({ filter, update }); return { modifiedCount: 1 }; },
});
stub('../../models/OutreachEnrollment', {
  updateMany: async (filter, update) => { calls.closeWarm.push({ filter, update }); return { modifiedCount: 2 }; },
});
stub('../../controllers/orders', {
  ensureProjectForCompany: async (body, opts) => {
    calls.project.push({ body, opts });
    return { order: { _id: 'o1', projectNumber: '000212', orderNumber: '', companyKey: body.companyKey, companyName: body.companyName, totalValue: 0 }, created: true };
  },
  ensureDealForProject: async (order, o) => { calls.deal.push({ order, o }); return { _id: 'd1', stage: 'quoting' }; },
});

const { convertToJob } = require('../warmHandoff');

const reset = () => {
  calls.project.length = 0; calls.deal.length = 0;
  calls.closeWarm.length = 0; calls.clientUpdate.length = 0;
  clientDoc = { companyKey: 'greenleaf', companyName: 'Green Leaf', clientName: 'Sam Rivera', dealValue: 0, log: [] };
};

// ── The whole point: the drip stops ──────────────────────────────────────────

test('converting a lead stops its outreach sequence', async () => {
  reset();
  const out = await convertToJob({ companyKey: 'greenleaf', enrollmentId: 'e1' });
  assert.equal(out.ok, true);
  assert.equal(out.stoppedSequences, 2);
  assert.equal(calls.closeWarm.length, 1);
  const { filter, update } = calls.closeWarm[0];
  assert.equal(update.$set.status, 'stopped');
  assert.equal(update.$set.stopReason, 'converted-to-job');
  assert.equal(update.$set.nextSendAt, null);
  // A lead that already replied sits at status 'replied' — scoping the stop to
  // 'active' (the old bug) matched zero rows and left the sequence running.
  assert.deepEqual(filter.status.$in.sort(), ['active', 'completed', 'replied']);
});

test('the project and the deal card are both created, and reported back', async () => {
  reset();
  const out = await convertToJob({ companyKey: 'greenleaf', value: 2400, title: 'Spring hoodies' });
  assert.equal(out.projectNumber, '000212');
  assert.equal(out.dealId, 'd1');
  assert.equal(out.created, true);
  assert.equal(calls.deal[0].o.title, 'Spring hoodies');
  assert.equal(calls.deal[0].o.value, 2400);
});

// ── The contact carried onto the job is the human who actually wrote ─────────

test('the replier becomes the project contact, not the address we mailed', async () => {
  reset();
  await convertToJob({
    companyKey: 'greenleaf', contactEmail: 'sam@greenleaf.com', contactName: 'Sam Rivera',
  });
  const { body } = calls.project[0];
  assert.equal(body.contactEmail, 'sam@greenleaf.com');
  assert.equal(body.contactName, 'Sam Rivera');
  assert.equal(body.companyName, 'Green Leaf');       // denormalized from the CRM
});

test('reuse attaches to the live project; reuse:false forces a fresh one', async () => {
  reset();
  await convertToJob({ companyKey: 'greenleaf' });
  assert.equal(calls.project[0].opts.forceNew, false);
  reset();
  await convertToJob({ companyKey: 'greenleaf', reuse: false });
  assert.equal(calls.project[0].opts.forceNew, true);
});

// ── Idempotent: a double-tap opens one job, not two log lines ────────────────

test('the CRM history line is written once per project', async () => {
  reset();
  await convertToJob({ companyKey: 'greenleaf' });
  assert.equal(calls.clientUpdate.length, 1);
  const entry = calls.clientUpdate[0].update.$push.log;
  assert.equal(entry.dedupKey, 'outreach-job:000212');
  assert.match(entry.text, /#000212/);

  // Second tap: the log already carries the key, so nothing is stacked.
  clientDoc = { ...clientDoc, log: [{ dedupKey: 'outreach-job:000212' }] };
  calls.clientUpdate.length = 0;
  const again = await convertToJob({ companyKey: 'greenleaf' });
  assert.equal(again.ok, true);
  assert.equal(calls.clientUpdate.length, 0);
});

test('a caller-supplied reason is used verbatim in the history', async () => {
  reset();
  await convertToJob({ companyKey: 'greenleaf', reason: 'Replied asking for pricing — converted' });
  assert.equal(calls.clientUpdate[0].update.$push.log.text, 'Replied asking for pricing — converted');
});

// ── Refuses what it can't do ────────────────────────────────────────────────

test('an unmatched reply (no company) converts nothing', async () => {
  reset();
  const out = await convertToJob({ companyKey: '' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-company');
  assert.equal(calls.project.length, 0);
  assert.equal(calls.closeWarm.length, 0);
});

test('a company with no CRM record still gets its project', async () => {
  reset();
  clientDoc = null;                     // reply matched by domain, never in the CRM
  const out = await convertToJob({ companyKey: 'newshop', contactEmail: 'a@newshop.com' });
  assert.equal(out.ok, true);
  assert.equal(out.projectNumber, '000212');
  assert.equal(calls.clientUpdate.length, 0);   // nothing to log against
});
