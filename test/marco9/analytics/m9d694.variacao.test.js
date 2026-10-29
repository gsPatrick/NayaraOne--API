'use strict';

// M9-D694 (3.1) — variação entre períodos calculada pelo servidor, com as duas datas, os dois snapshots e o aviso de mudança de versão.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d693Env');
const briefs = require('../../../src/features/analytics/briefs');
const { resolveBriefPeriods } = require('../../../src/features/analytics/briefs/brief.period');
const { findDefinition } = require('../../../src/features/analytics/metrics');

let env;
before(async () => { env = await e.setup(); });
after(async () => { await e.teardown(env); });

const A = () => env.tenantA;
const ctxOf = () => ({ groupId: A().groupId, companyId: A().companyId, actorUserId: null, permissions: ['analytics:read', 'finance:read'] });
async function variacao(tx, code) {
  const { current, previous } = resolveBriefPeriods('DAILY', new Date(e.NOW));
  return briefs.computeVariation({ ctx: ctxOf(), definition: await findDefinition(code, tx), companyId: A().companyId, periodCurrent: current, periodPrevious: previous }, tx);
}

test('m9d694 variação calculada pelo servidor com as duas datas e os dois snapshots', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const m = await e.metric(env, A(), tx, { current: '112000.00', previous: '130000.00' });
    const { variation } = await variacao(tx, m.code);
    assert.equal(Number(variation.current), 112000);
    assert.equal(Number(variation.previous), 130000);
    assert.equal(Number(variation.absolute), -18000);
    assert.equal(variation.percent, '-13.85', 'absoluta / |anterior| x 100 em 2 casas, meio para cima');
    assert.deepEqual(variation.periodCurrent, { startDate: '2026-10-27', endDate: '2026-10-27', asOfDate: '2026-10-27' });
    assert.deepEqual(variation.periodPrevious, { startDate: '2026-10-26', endDate: '2026-10-26', asOfDate: '2026-10-26' });
    assert.match(variation.snapshotCurrentId, /^[0-9a-f-]{36}$/);
    assert.match(variation.snapshotPreviousId, /^[0-9a-f-]{36}$/);
    assert.notEqual(variation.snapshotCurrentId, variation.snapshotPreviousId);
    assert.equal(variation.versionChanged, false);
    const [[snap]] = await e.sequelize.query('SELECT as_of_date::text AS d FROM analytics.metric_snapshots WHERE id = :id', { replacements: { id: variation.snapshotPreviousId }, transaction: tx });
    assert.equal(snap.d, '2026-10-26');
  });
});

test('m9d694 variação percentual com previous zero é nula', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const m = await e.metric(env, A(), tx, { current: '500.00', previous: '0.00' });
    const { variation } = await variacao(tx, m.code);
    assert.equal(Number(variation.absolute), 500);
    assert.equal(variation.percent, null, 'nunca divisão por zero');
    const semBase = await e.metric(env, A(), tx, { current: '500.00', previous: null });
    assert.equal((await variacao(tx, semBase.code)).variation, null, 'sem registro no período anterior não há variação');
    const negativa = await e.metric(env, A(), tx, { current: '-50.00', previous: '-100.00' });
    assert.equal((await variacao(tx, negativa.code)).variation.percent, '50.00', 'sobre o módulo do anterior');
  });
});

test('m9d694 mudança de versão entre períodos gera aviso', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const m = await e.metric(env, A(), tx, { current: '112000.00', previous: '130000.00', secondVersion: true });
    const { variation } = await variacao(tx, m.code);
    assert.equal(variation.versionChanged, true);
    assert.equal(variation.versionPrevious, 1);
    assert.equal(variation.versionCurrent, 2);
    assert.equal(variation.warning, 'A fórmula mudou entre os períodos.');
  });
});
