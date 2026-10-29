'use strict';

// M9-D615 — os números do read model batem com o ledger (100 eventos aleatórios), os demais componentes, a margem por setor e o sourceRefs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env615 = require('../_helpers/m9d615Env');
const { expectedFromLedger } = require('../_helpers/m9d615Oracle');
const registry = require('../../../src/features/analytics/metrics');

const { ledger, makeEvent, apply, healthRow, inTx } = env615;
let env;
before(async () => { env = await env615.setup(); });
after(() => env615.teardown(env));

function prng(seed) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const day = (n, hour = 15) => new Date(Date.UTC(2026, 9, 28 + n, hour)).toISOString();
const FIELDS = ['free_cash', 'third_party_cash', 'payables_7d', 'payables_30d', 'payables_60d', 'receivables_7d', 'receivables_30d', 'receivables_60d', 'overdue_payables', 'overdue_amount',
  'overdue_amount_in_window_90d', 'overdue_amount_outside_window_90d', 'receivables_base_90d', 'entries_without_due_date'];

test('m9d615 caixa livre do read model bate com o ledger depois de 100 eventos aleatórios', async () => {
  const rnd = prng(615);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const created = [];
  for (let i = 0; i < 100; i += 1) {
    const status = pick(['PENDING', 'PENDING', 'SETTLED', 'SETTLED', 'CANCELLED', 'REVERSED']);
    const nature = pick(['RECEIVABLE', 'PAYABLE']);
    const amount = (Math.floor(rnd() * 500000) / 100 + 0.01).toFixed(2);
    const dueOffset = Math.floor(rnd() * 160) - 100; // de 100 dias atrás a 60 dias à frente
    const reversal = i > 10 && rnd() < 0.05 ? pick(created) : null;
    const id = await ledger.entry(env, env.tenantA, {
      nature, amount, status, third: rnd() < 0.25, due: rnd() < 0.05 ? null : day(dueOffset), settled: status === 'SETTLED' ? day(-Math.floor(rnd() * 20), 15) : null,
      reversalOf: reversal, month: '2026-10',
    });
    created.push(id);
    await apply(env.tenantA, makeEvent(env.tenantA, status === 'SETTLED' ? 'finance.entry.settled' : 'finance.entry.created', { id, resultCenterId: null, competenceMonth: '2026-10' }));
  }
  const row = await healthRow(env, env.tenantA);
  const want = expectedFromLedger(await env615.ledgerRows(env, env.tenantA), env615.AS_OF, 90);
  for (const field of FIELDS) assert.equal(String(row[field]), String(want[field]), field);
  // a taxa de inadimplência tem base e vencido dentro da mesma janela: nunca passa de 100%
  assert.equal(Number(row.overdue_amount_in_window_90d) <= Number(row.receivables_base_90d), true);
  assert.equal(Number(row.overdue_amount), Number(row.overdue_amount_in_window_90d) + Number(row.overdue_amount_outside_window_90d));
  assert.equal(registry.reconcileModeForUnit('BRL'), 'SUM');
});

test('m9d615 o sourceRefs do componente reconcilia com o valor guardado (critérios do read model)', async () => {
  const row = await healthRow(env, env.tenantA);
  assert.ok(row.source_criteria['fin.free_cash'], 'o read model guarda os critérios do componente');
  await inTx(env.tenantA, {}, async (tx) => {
    const ctx = { groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, actorUserId: env.tenantA.userId, permissions: ['analytics:read'] };
    const comps = ['free_cash', 'third_party_cash', 'payables_7d', 'payables_30d', 'payables_60d', 'receivables_7d', 'receivables_30d', 'receivables_60d', 'overdue_payables'];
    for (const name of comps) {
      const code = `fin.${name}`;
      const { sourceRefs: [ref] } = await registry.buildSourceRefs(ctx, code, { filter: row.source_criteria[code], unit: 'BRL' }, tx);
      assert.equal(ref.restricted, true, 'sem permissão de detalhe os ids não saem');
      const r = await registry.reconcileDetail(ctx, code, ref, row[name], { unit: 'BRL' }, tx);
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x read model ${r.kpi}`);
    }
    const composite = await registry.buildSourceRefs(ctx, 'fin.breathing_need', { componentFilters: row.source_criteria, units: { 'fin.overdue_payables': 'BRL', 'fin.payables_30d': 'BRL', 'fin.commissions_unlinked_30d': 'BRL', 'fin.free_cash': 'BRL' } }, tx);
    assert.deepEqual(composite.components.map((c) => c.metricCode), ['fin.overdue_payables', 'fin.payables_30d', 'fin.commissions_unlinked_30d', 'fin.free_cash']);
  });
});

test('m9d615 pendências, repasses, comissões e anomalias entram só como agregados', async () => {
  const t = env.tenantB;
  const account = ledger.uuid();
  for (const amount of ['100.00', '-40.50']) await ledger.insert(env, 'bank_transactions', t, { bank_account_id: account, amount, transaction_date: day(-3) });
  const matchedTx = await ledger.insert(env, 'bank_transactions', t, { bank_account_id: account, amount: '9.00', transaction_date: day(-3) });
  await ledger.insert(env, 'reconciliations', t, { financial_entry_id: ledger.uuid(), bank_transaction_id: matchedTx, matched_at: day(-2) });
  await ledger.insert(env, 'owner_repasses', t, { property_id: ledger.uuid(), owner_person_id: ledger.uuid(), gross_amount: '60000.00', net_amount: '54000.00', status: 'PENDING', reference_month: '2026-10' });
  await ledger.insert(env, 'owner_repasses', t, { property_id: ledger.uuid(), owner_person_id: ledger.uuid(), gross_amount: '1000.00', net_amount: '900.00', status: 'CANCELLED', reference_month: '2026-09' });
  const commission = await ledger.insert(env, 'commissions', t, { beneficiary_user_id: ledger.uuid(), base_amount: '300000.00', percentage: '0.05', total_amount: '21000.00', status: 'APPROVED', rule_version_id: ledger.uuid(), source_entry_id: ledger.uuid(), component: 'BROKER' });
  await ledger.insert(env, 'commission_installments', t, { commission_id: commission, installment_number: 1, amount: '15000.00', due_at: day(10), status: 'PENDING' });
  await ledger.insert(env, 'commission_installments', t, { commission_id: commission, installment_number: 2, amount: '6000.00', due_at: day(-4), status: 'PENDING' });
  await ledger.insert(env, 'commission_installments', t, { commission_id: commission, installment_number: 3, amount: '18000.00', due_at: day(-30), status: 'PAID', paid_at: day(-2) });
  await ledger.insert(env, 'anomaly_cases', t, { case_type: 'DUPLICATE', risk_level: 'HIGH', reason: 'x', status: 'OPEN' });
  await ledger.insert(env, 'anomaly_cases', t, { case_type: 'DUPLICATE', risk_level: 'LOW', reason: 'x', status: 'RESOLVED' });
  await apply(t, makeEvent(t, 'finance.commission.created', { id: commission }));
  const row = await healthRow(env, t);
  assert.equal(row.pending_reconciliations, 2, 'transações importadas sem conciliação');
  assert.equal(row.pending_owner_repasses, '54000.00', 'só o repasse pendente');
  assert.equal(row.provisioned_commissions, '21000.00', '15.000 + 6.000 devidos e ainda não pagos');
  assert.equal(row.paid_commissions, '18000.00');
  assert.equal(row.open_anomalies, 1);
  assert.equal(row.commissions_unlinked_30d, '21000.00', 'as duas parcelas pendentes vencem em até 30 dias e não têm lançamento');
  const want = Number(row.overdue_payables) + Number(row.payables_30d) + 21000 - Number(row.free_cash);
  assert.equal(Number(row.breathing_need), Math.max(0, want), 'necessidade para respirar = max(0, vencido + a pagar 30d + comissões - caixa livre)');
});

test('m9d615 margem por setor: receita e custo realizados por centro e competência', async () => {
  const t = env.tenantA;
  const center = ledger.uuid();
  const rows = [['RECEIVABLE', '80000.00', center], ['PAYABLE', '52000.00', center], ['RECEIVABLE', '1000.00', null], ['PAYABLE', '10.00', center]];
  let last;
  for (const [nature, amount, c] of rows) {
    last = await ledger.entry(env, t, { nature, amount, status: 'SETTLED', settled: day(-1), center: c, month: '2026-09' });
    await apply(t, makeEvent(t, 'finance.entry.settled', { id: last, resultCenterId: c, competenceMonth: '2026-09' }));
  }
  await ledger.entry(env, t, { nature: 'RECEIVABLE', amount: '5.00', status: 'SETTLED', settled: day(-1), center, month: '2026-09', third: true });
  const [[sector]] = await env.admin.query('SELECT revenue_actual::text AS r, cost_actual::text AS c, source_snapshot_at, version FROM analytics.rm_finance_sector_margin WHERE company_id = :c AND result_center_id = :r AND competence_month = :m',
    { replacements: { c: t.companyId, r: center, m: '2026-09' } });
  assert.deepEqual([sector.r, sector.c], ['80000.00', '52010.00'], 'terceiros não entram na margem');
  const [[none]] = await env.admin.query('SELECT revenue_actual::text AS r FROM analytics.rm_finance_sector_margin WHERE company_id = :c AND result_center_id = :r AND competence_month = :m',
    { replacements: { c: t.companyId, r: '00000000-0000-0000-0000-000000000000', m: '2026-09' } });
  assert.equal(none.r, '1000.00', 'lançamento sem centro vai para "sem setor"');
  assert.ok(sector.source_snapshot_at && sector.version === 1);
});
