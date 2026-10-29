'use strict';

// M9-D625 — read model rm_finance_intercompany: uma linha por transferência aprovada, da empresa de origem, com o estado dos dois lados; atualização por
// evento e pela agenda (a baixa do destino não gera evento para a origem), isolamento por empresa (RLS) e replay do mesmo evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e625 = require('../_helpers/m9d625Env');
const asserts = require('../_helpers/readModelAsserts');
const readModels = require('../../../src/features/analytics/read-models');

let env;
before(async () => { env = await e625.setup(); });
after(() => e625.teardown(env));

const byId = (rows, id) => rows.find((r) => r.transfer_id === id);

test('m9d625 a transferência aprovada vira uma linha da empresa de origem com o estado dos dois lados', async () => {
  const ok = await e625.transfer(env, env.cX, env.cY, { amount: '10000.00' });
  const lone = await e625.transfer(env, env.cX, env.cY, { amount: '4000.00', toStatus: 'CANCELLED' });
  const mismatch = await e625.transfer(env, env.cX, env.cY, { amount: '3000.00', toAmount: '2999.00' });
  const void625 = await e625.transfer(env, env.cX, env.cY, { amount: '1.00', fromStatus: 'CANCELLED', toStatus: 'REVERSED' });
  const onlyTo = await e625.transfer(env, env.cX, env.cY, { amount: '2.00', fromStatus: 'CANCELLED' });
  await e625.refreshPairs(env.cX);
  const rows = await e625.pairRows(env, env.cX);
  assert.deepEqual(rows.map((r) => r.pair_state).sort(), ['AMOUNT_MISMATCH', 'MATCHED', 'ONLY_FROM', 'ONLY_TO']);
  assert.equal(byId(rows, ok.id).pair_state, 'MATCHED');
  assert.equal(byId(rows, lone.id).pair_state, 'ONLY_FROM');
  assert.equal(byId(rows, mismatch.id).pair_state, 'AMOUNT_MISMATCH');
  assert.equal(byId(rows, onlyTo.id).pair_state, 'ONLY_TO');
  assert.equal(byId(rows, void625.id), undefined, 'sem nenhum lado vivo não há efeito no ledger e a transferência não vira linha');
  const matched = byId(rows, ok.id);
  assert.equal(matched.company_id, env.cX.companyId, 'a linha é da empresa de origem');
  assert.equal(matched.to_company_id, env.cY.companyId);
  assert.deepEqual([matched.amount, matched.from_amount, matched.to_amount, matched.from_entry_status, matched.to_entry_status], ['10000.00', '10000.00', '10000.00', 'SETTLED', 'SETTLED']);
  assert.equal(matched.transfer_status, 'PENDING');
  assert.deepEqual((await e625.pairRows(env, env.cY)), [], 'a empresa de destino não tem linha própria da transferência');
});

test('m9d625 isolamento: a empresa de destino não enxerga a linha da origem pelo contexto de RLS', async () => {
  const asY = await e625.inTx(env.cY, {}, async (tx) => (await require('../../testHelpers').sequelize.query('SELECT count(*)::int AS n FROM analytics.rm_finance_intercompany', { transaction: tx }))[0][0].n);
  const asX = await e625.inTx(env.cX, {}, async (tx) => (await require('../../testHelpers').sequelize.query('SELECT count(*)::int AS n FROM analytics.rm_finance_intercompany', { transaction: tx }))[0][0].n);
  assert.equal(asY, 0);
  assert.equal(asX, 4);
});

test('m9d625 a baixa do destino chega pela agenda: a transferência pendente num lado vira inteira quando o outro lado liquida', async () => {
  const t = await e625.transfer(env, env.cX, env.cY, { amount: '500.00', toStatus: 'PENDING' });
  await e625.refreshPairs(env.cX);
  assert.equal(byId(await e625.pairRows(env, env.cX), t.id).to_entry_status, 'PENDING');
  await env.admin.query("UPDATE finance.financial_entries SET status = 'SETTLED', settled_at = '2026-10-21T15:00:00Z' WHERE id = :id", { replacements: { id: t.toEntry } });
  await e625.inTx(env.cX, { commit: true }, async (tx) => {
    const params = await readModels.readRefreshParams(env.cX, tx);
    await readModels.refreshCompanyScheduled({ companyId: env.cX.companyId, groupId: env.cX.groupId }, params, tx, { now: e625.NOW });
  });
  const row = byId(await e625.pairRows(env, env.cX), t.id);
  assert.deepEqual([row.pair_state, row.to_entry_status], ['MATCHED', 'SETTLED']);
});

test('m9d625 cancelar o lado do destino derruba o par para incompleto e cancelar os dois tira a linha', async () => {
  const t = await e625.transfer(env, env.cX, env.cY, { amount: '600.00' });
  await e625.refreshPairs(env.cX);
  assert.equal(byId(await e625.pairRows(env, env.cX), t.id).pair_state, 'MATCHED');
  await env.admin.query("UPDATE finance.financial_entries SET status = 'CANCELLED' WHERE id = :id", { replacements: { id: t.toEntry } });
  await e625.refreshPairs(env.cX);
  assert.equal(byId(await e625.pairRows(env, env.cX), t.id).pair_state, 'ONLY_FROM');
  await env.admin.query("UPDATE finance.financial_entries SET status = 'CANCELLED' WHERE id = :id", { replacements: { id: t.fromEntry } });
  await e625.refreshPairs(env.cX);
  assert.equal(byId(await e625.pairRows(env, env.cX), t.id), undefined);
});

test('m9d625 replay do mesmo evento não altera o read model', async () => {
  const ev = e625.event(env.cX);
  await asserts.assertReplayIdempotent({
    applyEvent: () => e625.inTx(env.cX, { commit: true }, (tx) => readModels.applyEvent(ev, tx, { now: e625.NOW })),
    readRow: async () => (await e625.pairRows(env, env.cX)).map((r) => ({ ...r, refreshed_at: null })),
  });
});
