'use strict';

// M9-D615 — o worker do BI (M9-D607) aplicado ao read model financeiro: replay, rebuild, carimbos de tempo, isolamento, atomicidade e agenda.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env615 = require('../_helpers/m9d615Env');
const asserts = require('../_helpers/readModelAsserts');
const readModels = require('../../../src/features/analytics/read-models');
const { expectedFromLedger } = require('../_helpers/m9d615Oracle');

const { ledger, makeEvent, apply, healthRow, inTx, NOW, AS_OF } = env615;
let env;
before(async () => { env = await env615.setup(); });
after(() => env615.teardown(env));

const iso = (offsetDays, hour = 15) => new Date(Date.UTC(2026, 9, 28 + offsetDays, hour)).toISOString();
const settledEvent = (tenant, id) => makeEvent(tenant, 'finance.entry.settled', { id, resultCenterId: null, competenceMonth: '2026-10' });
// só a data-base do teste: linhas de outras datas deixadas por outros arquivos no mesmo banco (ex.: m9d607.*) não entram na conta
const rowsOf = async (tenant) => (await env.admin.query('SELECT * FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = :d', { replacements: { c: tenant.companyId, d: AS_OF } }))[0];

test('m9d615 replay do mesmo evento não duplica', async () => {
  const id = await ledger.entry(env, env.tenantA, { nature: 'RECEIVABLE', amount: '120000.00', status: 'SETTLED', settled: iso(-2), month: '2026-10' });
  const event = settledEvent(env.tenantA, id);
  const { before: row } = await asserts.assertReplayIdempotent({ applyEvent: () => apply(env.tenantA, event), readRow: () => healthRow(env, env.tenantA) });
  assert.equal(Number(row.free_cash) >= 120000, true);
  assert.equal((await rowsOf(env.tenantA)).length, 1, 'continua uma linha por empresa e data-base');
});

test('m9d615 rebuild reproduz o incremental', async () => {
  const ids = [];
  for (const [nature, amount, status, due] of [['PAYABLE', '500.00', 'PENDING', iso(3)], ['RECEIVABLE', '800.00', 'PENDING', iso(-5)], ['PAYABLE', '77.70', 'PENDING', iso(40)]]) {
    ids.push(await ledger.entry(env, env.tenantB, { nature, amount, status, due }));
  }
  const read = () => rowsOf(env.tenantB);
  const hash = await asserts.assertRebuildEqualsIncremental({
    buildIncremental: async () => { for (const id of ids) await apply(env.tenantB, settledEvent(env.tenantB, id)); },
    readRows: read,
    wipe: () => env.admin.query('DELETE FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = :d', { replacements: { c: env.tenantB.companyId, d: AS_OF } }),
    // rebuild a partir das tabelas de origem: a passada da agenda recalcula o estado de cada chave (sem nenhum evento)
    rebuild: () => inTx(env.tenantB, { commit: true }, async (tx) => {
      await readModels.refreshCompanyScheduled({ companyId: env.tenantB.companyId, groupId: env.tenantB.groupId }, await readModels.readRefreshParams(env.tenantB, tx), tx, { now: NOW });
    }),
  });
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('m9d615 source_snapshot_at e refreshed_at gravados', async () => {
  const id = await ledger.entry(env, env.tenantA, { nature: 'PAYABLE', amount: '10.00', status: 'PENDING', due: iso(1) });
  await apply(env.tenantA, settledEvent(env.tenantA, id));
  const row = await healthRow(env, env.tenantA);
  assert.equal(new Date(row.source_snapshot_at).toISOString(), NOW.toISOString(), 'instante da fotografia da fonte');
  assert.ok(row.refreshed_at, 'refreshed_at gravado');
  assert.equal(row.version, 1);
  assert.equal(row.as_of_date, '2026-10-28');
});

test('m9d615 isolamento entre empresas', async () => {
  const idB = await ledger.entry(env, env.tenantB, { nature: 'RECEIVABLE', amount: '999.99', status: 'SETTLED', settled: iso(-1) });
  const beforeA = await healthRow(env, env.tenantA);
  await apply(env.tenantB, settledEvent(env.tenantB, idB));
  const afterA = await healthRow(env, env.tenantA);
  assert.deepEqual(afterA, beforeA, 'só o read model de B muda');
  assert.ok((await healthRow(env, env.tenantB)).refreshed_at);
  await inTx(env.tenantA, {}, async (tx) => {
    const [rows] = await tx.sequelize.query('SELECT company_id FROM analytics.rm_finance_health', { transaction: tx });
    assert.ok(rows.length > 0 && rows.every((r) => r.company_id === env.tenantA.companyId), 'sob o RLS de A só aparecem linhas de A');
  });
  await inTx(env.tenantB, {}, async (tx) => {
    const [rows] = await tx.sequelize.query('SELECT 1 FROM analytics.rm_finance_health WHERE company_id = :a', { replacements: { a: env.tenantA.companyId }, transaction: tx });
    assert.equal(rows.length, 0);
  });
});

test('m9d615 erro no meio desfaz a atualização', async () => {
  const id = await ledger.entry(env, env.tenantA, { nature: 'RECEIVABLE', amount: '5.00', status: 'PENDING', due: iso(2), center: null, month: '2026-11' });
  const event = makeEvent(env.tenantA, 'finance.entry.created', { id, resultCenterId: null, competenceMonth: '2026-11' });
  const before = await healthRow(env, env.tenantA);
  const margin = readModels.getReadModel('rm_finance_sector_margin');
  const original = margin.recompute;
  margin.recompute = async () => { throw Object.assign(new Error('falha simulada na margem'), { code: 'M9D615_FALHA' }); };
  try {
    await assert.rejects(apply(env.tenantA, event), (e) => e.code === 'M9D615_FALHA');
  } finally { margin.recompute = original; }
  assert.deepEqual(await healthRow(env, env.tenantA), before, 'a saúde financeira, aplicada antes da falha, também foi desfeita');
  const [[reg]] = await env.admin.query("SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE source_event_id = :e", { replacements: { e: String(event.id) } });
  assert.equal(reg.n, 0, 'o evento não ficou marcado como aplicado');
  assert.ok((await apply(env.tenantA, event)).upserted >= 2, 'sem a falha o mesmo evento é aplicado normalmente (nos dois read models do Financeiro e em quem mais consome o lançamento)');
});

test('m9d615 agenda recalcula o que depende do relógio', async () => {
  const dueSoon = await ledger.entry(env, env.tenantB, { nature: 'PAYABLE', amount: '1000.00', status: 'PENDING', due: iso(9, 15) }); // 06/11, fora dos 7 dias de 28/10
  await apply(env.tenantB, settledEvent(env.tenantB, dueSoon));
  const run = (now) => inTx(env.tenantB, { commit: true }, async (tx) => {
    const params = await readModels.readRefreshParams(env.tenantB, tx);
    return readModels.refreshCompanyScheduled({ companyId: env.tenantB.companyId, groupId: env.tenantB.groupId }, params, tx, { now });
  });
  const entries = await env615.ledgerRows(env, env.tenantB);
  const oct28 = await healthRow(env, env.tenantB);
  for (const [now, asOf] of [['2026-11-01T15:00:00Z', '2026-11-01'], ['2026-11-10T15:00:00Z', '2026-11-10']]) {
    await run(new Date(now)); // sem nenhum evento: só a passagem do tempo
    const row = await healthRow(env, env.tenantB, asOf);
    const want = expectedFromLedger(entries, asOf, 90);
    for (const field of ['payables_7d', 'payables_30d', 'payables_60d', 'overdue_payables', 'receivables_7d', 'overdue_amount']) assert.equal(row[field], want[field], `${asOf} ${field}`);
  }
  const without = entries.filter((e) => e.id !== dueSoon);
  const gap = (row, asOf, field) => (Number(row[field]) - Number(expectedFromLedger(without, asOf, 90)[field])).toFixed(2);
  assert.equal(gap(oct28, '2026-10-28', 'payables_7d'), '0.00', 'em 28/10 o vencimento de 06/11 está fora dos 7 dias');
  assert.equal(gap(await healthRow(env, env.tenantB, '2026-11-01'), '2026-11-01', 'payables_7d'), '1000.00', 'em 01/11 entrou na janela de 7 dias, sem nenhum evento');
  assert.equal(gap(await healthRow(env, env.tenantB, '2026-11-10'), '2026-11-10', 'overdue_payables'), '1000.00', 'em 10/11 já venceu e passou a vencido');
  const [refresh] = (await env.admin.query("SELECT \"trigger\", status FROM analytics.read_model_refreshes WHERE read_model = 'rm_finance_health' AND company_id = :c ORDER BY started_at DESC LIMIT 1", { replacements: { c: env.tenantB.companyId } }))[0];
  assert.deepEqual([refresh.trigger, refresh.status], ['SCHEDULE', 'SUCCEEDED']);
});
