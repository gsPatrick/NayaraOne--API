'use strict';

// M9-D805 — duas decisões simultâneas sobre o mesmo item: uma vence, a outra recebe 409. Precisa de commit real: banco descartável
// (nunca o .env remoto). Os dados criados ficam no cluster descartável, que é apagado ao final.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d805Env');
const mergeService = require('../../../src/features/core-governance/data-quality/merge.service');
const { withTenantTransaction } = require('../../testHelpers');
const { adminQuery } = require('../../m9d801.helpers');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;

async function committedPair() {
  return withTenantTransaction(A(), async (tx) => {
    const first = await env.person(A(), tx, { legalName: 'Concorrência QA-M9' });
    const second = await env.person(A(), tx, { legalName: 'Concorrência QA-M9' });
    const item = await env.candidate(A(), tx, 'PERSON', first.id, second.id);
    const { actor } = await env.steward(A(), tx);
    return { item, actor };
  });
}

const settle = (promises) => Promise.allSettled(promises).then((results) => ({
  won: results.filter((r) => r.status === 'fulfilled'), lost: results.filter((r) => r.status === 'rejected').map((r) => r.reason),
}));

test('m9d805 duas decisões simultâneas: uma vence', { skip: skip() }, async () => {
  const { item, actor } = await committedPair();
  const attempt = (body) => withTenantTransaction(A(), (tx) => mergeService.decide(A(), actor, item.id, body, tx));
  const { won, lost } = await settle([attempt({ decision: 'KEPT_SEPARATE' }), attempt({ decision: 'DISMISSED' })]);
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.deepEqual([lost[0].statusCode, lost[0].code], [409, 'GOV_QUEUE_ITEM_FINAL']);
  const { rows: [row] } = await adminQuery('SELECT status FROM governance.review_queue_items WHERE id = $1', [item.id]);
  assert.equal(row.status, won[0].value.status);
});

test('m9d805 duas uniões simultâneas com sobreviventes diferentes: uma só une', { skip: skip() }, async () => {
  const { item, actor } = await committedPair();
  const attempt = (survivorId) => withTenantTransaction(A(), (tx) => mergeService.decide(A(), actor, item.id, { decision: 'MERGED', survivorId }, tx));
  const { won, lost } = await settle([attempt(item.primary_id), attempt(item.secondary_id)]);
  assert.equal(won.length, 1);
  assert.deepEqual([lost[0].statusCode, lost[0].code], [409, 'GOV_QUEUE_ITEM_FINAL']);
  const { rows } = await adminQuery('SELECT id, status, merged_into_id FROM people.persons WHERE id = ANY($1)', [[item.primary_id, item.secondary_id]]);
  assert.equal(rows.filter((r) => r.status === 'MERGED').length, 1, 'um absorvido só, nunca os dois');
  assert.equal(rows.find((r) => r.status === 'MERGED').merged_into_id, won[0].value.survivorId);
});
