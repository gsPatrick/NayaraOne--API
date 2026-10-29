'use strict';

// M9-D710 — consumo idempotente por sourceEventId (M9-D607) e rebuild a partir das tabelas de origem (M9-D608) com o mesmo hash do incremental, além do isolamento entre empresas (RLS).
// Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d710Env');
const sc = require('../_helpers/m9d710Scenario');
const asserts = require('../_helpers/readModelAsserts');

let env;
let ids;
before(async () => {
  env = await kit.setup();
  ids = { contracts: await sc.contratos(env, env.cX), opps: await sc.oportunidades(env, env.cX), payments: await sc.pagamentos(env, env.cX) };
});
after(() => kit.teardown(env));

const EVENTS = () => [
  ...['grande', 'aluguel', 'noite', 'anterior'].map((k) => ['legal.contract.status_changed', { id: ids.contracts[k], fromStatus: 'SIGNING', toStatus: 'SIGNED' }, ids.contracts[k]]),
  ...['a', 'b', 'semProposta', 'anterior'].map((k) => ['crm.opportunity.won', { id: ids.opps[k] }, ids.opps[k]]),
  ...['abaixo', 'limiar', 'grande', 'terceiros', 'anterior'].map((k) => ['finance.entry.settled', { id: ids.payments[k] }, ids.payments[k]]),
];
const rowsOf = (t, sourceId) => async () => (await env.admin.query('SELECT * FROM analytics.rm_command_events WHERE company_id = :c AND source_id = :s ORDER BY revision', { replacements: { c: t.companyId, s: sourceId } }))[0];

test('m9d710 replay e rebuild idênticos: o mesmo evento duas vezes não altera nada (nem refreshed_at)', async () => {
  for (const [type, payload, sourceId] of EVENTS()) {
    const event = kit.makeEvent(env.cX, type, payload);
    const { before } = await asserts.assertReplayIdempotent({ applyEvent: () => kit.apply(env.cX, event), readRow: rowsOf(env.cX, sourceId) });
    assert.ok(before.length >= 1, `${type}: o fato gravou linha`);
  }
  const [rows] = await env.admin.query("SELECT kind, count(*)::int AS n FROM analytics.rm_command_events WHERE company_id = :c GROUP BY kind ORDER BY kind", { replacements: { c: env.cX.companyId } });
  assert.deepEqual(rows, [{ kind: 'CONTRACT_SIGNED', n: 4 }, { kind: 'OPPORTUNITY_WON', n: 4 }, { kind: 'PAYMENT_SETTLED', n: 5 }], 'só os fatos: rascunho, perdida, pendente, cancelado e recebimento ficam de fora');
});

test('m9d710 rebuild a partir das tabelas de origem reproduz o incremental (hash por empresa)', async () => {
  const t = env.cX;
  const ctx = { groupId: t.groupId, actorUserId: t.userId, permissions: ['analytics:rebuild'], reason: 'Reconstrução após limpeza da tabela no teste da M9-D710.' };
  const hash = await asserts.assertRebuildEqualsIncremental({
    buildIncremental: async () => { for (const [type, payload] of EVENTS()) await kit.apply(t, kit.makeEvent(t, type, payload, { id: kit.uuid() })); },
    readRows: async () => (await env.admin.query('SELECT * FROM analytics.rm_command_events WHERE company_id = :c', { replacements: { c: t.companyId } }))[0],
    wipe: () => env.admin.query('DELETE FROM analytics.rm_command_events WHERE company_id = :c', { replacements: { c: t.companyId } }),
    rebuild: async () => { const out = await kit.readModels.rebuildReadModel(ctx, { model: 'rm_command_events', companyId: t.companyId }); assert.equal(out.status, 'SUCCEEDED'); },
  });
  assert.match(hash, /^[0-9a-f]{64}$/);
  const [byKind] = await env.admin.query("SELECT kind, count(*) FILTER (WHERE source_event_id IS NOT NULL)::int AS n FROM analytics.rm_command_events WHERE company_id = :c GROUP BY kind ORDER BY kind", { replacements: { c: t.companyId } });
  assert.deepEqual(byKind, [{ kind: 'CONTRACT_SIGNED', n: 4 }, { kind: 'OPPORTUNITY_WON', n: 4 }, { kind: 'PAYMENT_SETTLED', n: 5 }], 'cada fato guarda o id do evento do outbox que o gerou (determinístico, por isso o hash do rebuild é igual)');
});

test('m9d710 o rebuild declara a enumeração das chaves da fonte e o consumo cobre os três tipos de fato', () => {
  const def = kit.readModels.getReadModel('rm_command_events');
  assert.equal(typeof def.rebuild.keys, 'function');
  assert.deepEqual(def.aggregateColumns, ['kind', 'source_id']);
  for (const type of ['legal.contract.status_changed', 'crm.opportunity.won', 'crm.opportunity.stage_changed', 'finance.entry.settled', 'finance.entry.reversed']) assert.ok(def.eventTypes.includes(type), type);
});

test('m9d710 isolamento entre empresas: o evento e a agenda de X não escrevem em Y e, sob a identidade de Y, as linhas de X não aparecem', async () => {
  assert.ok((await env.admin.query('SELECT 1 FROM analytics.rm_command_events WHERE company_id = :c', { replacements: { c: env.cX.companyId } }))[0].length >= 1);
  assert.equal((await env.admin.query('SELECT 1 FROM analytics.rm_command_events WHERE company_id = :c', { replacements: { c: env.cY.companyId } }))[0].length, 0, 'Y continua vazia');
  const seenByY = await kit.inTx(env.cY, {}, async (tx) => (await kit.sequelize.query('SELECT count(*)::int AS n FROM analytics.rm_command_events WHERE company_id = :x', { replacements: { x: env.cX.companyId }, transaction: tx }))[0][0].n);
  assert.equal(seenByY, 0, 'RLS: Y não enxerga X');
  const writeAsY = kit.inTx(env.cY, {}, async (tx) => kit.sequelize.query(
    "INSERT INTO analytics.rm_command_events (company_id, group_id, kind, source_type, source_id, count_effect) VALUES (:x, :g, 'PAYMENT_SETTLED', 'FinancialEntry', gen_random_uuid(), 1)", { replacements: { x: env.cX.companyId, g: env.cX.groupId }, transaction: tx }
  ));
  await assert.rejects(writeAsY, 'sem o escritor do BI (worker) e com a empresa errada, a escrita é recusada pela RLS');
});
