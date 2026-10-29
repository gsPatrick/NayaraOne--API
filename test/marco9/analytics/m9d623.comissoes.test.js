'use strict';

// M9-D623 — KPIs fin.commissions_provisioned e fin.commissions_paid: reprodução a partir das parcelas, qualidade ("Sem corretor", paga sem lançamento),
// fuso de São Paulo, isolamento e replay.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envK = require('../_helpers/finKpiEnv');
const sc = require('../_helpers/m9d623Scenario');
const { commissionsFromSource } = require('../_helpers/m9d623Oracle');
const { storedDimension } = require('../_helpers/m9d623Stored');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const { refresh, kpis, readKpi, dayAt } = envK;
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
let env;
let brokerA;
before(async () => {
  env = await envK.setup();
  [[{ id: brokerA }]] = await env.admin.query("SELECT id FROM core.users WHERE status = 'ACTIVE' AND deleted_at IS NULL ORDER BY created_at LIMIT 1");
  await sc.seedCommissions(env, env.cX, brokerA);
  await refresh(env.cX);
  await kpis(env.cX);
});
after(() => envK.teardown(env));

test('m9d623 reproduz fin.commissions_provisioned a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await commissionsFromSource(env, t, env.asOf);
  assert.equal(want.provisioned, '21000.00', 'exemplo do livro: 15.000,00 + 6.000,00');
  const got = await readKpi(t, 'fin.commissions_provisioned');
  same(got.value, want.provisioned, 'valor');
  assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'BRL', 1, 'PLANNED']);
  for (const [broker, amount] of Object.entries(want.provisionedByBroker)) same((await readKpi(t, 'fin.commissions_provisioned', { dimensionKey: `corretor:${broker}` })).value, amount, `corretor ${broker}`);
  for (const [component, amount] of Object.entries(want.provisionedByComponent)) same((await readKpi(t, 'fin.commissions_provisioned', { dimensionKey: `tipo:${component}` })).value, amount, `tipo ${component}`);
  assert.equal(got.sourceRefs[0].table, 'finance.commission_installments');
  assert.equal(got.sourceRefs[0].count, 2, 'o sourceRefs conta as duas parcelas somadas');
});

test('m9d623 fin.commissions_provisioned fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const t = env.cY;
  await sc.seedCommissions(env, t, brokerA, { withoutBroker: true });
  await refresh(t);
  await kpis(t);
  const bad = await readKpi(t, 'fin.commissions_provisioned');
  assert.equal(bad.status, 'DEGRADED');
  assert.equal(bad.value, null, 'valor nulo, nunca número enganoso');
  same(await storedDimension(env, t, 'fin.commissions_provisioned', 'sem_corretor_brl'), '1000.00', 'a parcela sem corretor é contada em "Sem corretor"');
  same(await storedDimension(env, t, 'fin.commissions_provisioned', `corretor:${brokerA}`), '21000.00', 'o que tem corretor continua visível');
  assert.equal(Number(await storedDimension(env, t, 'fin.commissions_provisioned', 'sem_corretor_qtd')), 1);
});

test('m9d623 reproduz fin.commissions_paid a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await commissionsFromSource(env, t, env.asOf);
  assert.equal(want.paid, '18000.00', 'exemplo do livro: outubro 18.000,00 (a parcela de setembro não entra)');
  const got = await readKpi(t, 'fin.commissions_paid');
  same(got.value, want.paid, 'valor');
  assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'BRL', 1, 'ACTUAL']);
  for (const [broker, amount] of Object.entries(want.paidByBroker)) same((await readKpi(t, 'fin.commissions_paid', { dimensionKey: `corretor:${broker}` })).value, amount, `corretor ${broker}`);
  same((await readKpi(t, 'fin.commissions_paid', { dimensionKey: 'mes:2026-10' })).value, '18000.00', 'dimensão mês');
  assert.equal(got.sourceRefs[0].count, 1);
});

test('m9d623 fin.commissions_paid fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const t = env.cY;
  await sc.seedCommissions(env, t, brokerA, { paidWithoutEntry: true });
  await refresh(t);
  await kpis(t);
  const bad = await readKpi(t, 'fin.commissions_paid');
  assert.equal(bad.status, 'DEGRADED');
  assert.equal(bad.value, null);
  assert.equal(Number(await storedDimension(env, t, 'fin.commissions_paid', 'sem_lancamento_qtd')), 1, 'a parcela paga sem lançamento é contada');
});

test('m9d623 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cX;
  const want = await commissionsFromSource(env, t, env.asOf);
  assert.equal(want.paid, '18000.00');
  // pagamento em 31/10 às 23:30 (01/11 02:30Z) pertence a outubro; em 01/11 às 00:30 (03:30Z) pertence a novembro
  const commission = await envK.ledger.insert(env, 'commissions', t, { beneficiary_user_id: brokerA, base_amount: '1.00', percentage: '0.01', total_amount: '3.33', status: 'APPROVED', rule_version_id: envK.ledger.uuid(), source_entry_id: envK.ledger.uuid(), component: 'BROKER' });
  const entryId = await sc.entry(env, t, { nature: 'PAYABLE', amount: '3.33' });
  await envK.ledger.insert(env, 'commission_installments', t, { commission_id: commission, installment_number: 1, amount: '1.11', due_at: dayAt(0), status: 'PAID', paid_at: '2026-11-01T02:30:00.000Z', financial_entry_id: entryId });
  await envK.ledger.insert(env, 'commission_installments', t, { commission_id: commission, installment_number: 2, amount: '2.22', due_at: dayAt(0), status: 'PAID', paid_at: '2026-11-01T03:30:00.000Z', financial_entry_id: entryId });
  await refresh(t);
  await kpis(t);
  const after = await commissionsFromSource(env, t, env.asOf);
  same(after.paid, money.money(money.add(want.paid, '1.11')), 'o recálculo na mão: a parcela das 23:30 de 31/10 é de outubro e a das 00:30 de 01/11 não');
  same((await readKpi(t, 'fin.commissions_paid')).value, after.paid, 'o KPI concorda com o recálculo independente');
});

test('m9d623 isolamento entre empresas no KPI', async () => {
  const [x, y] = [env.cX, env.cY];
  same((await readKpi(x, 'fin.commissions_provisioned')).value, '21000.00', 'X só vê as próprias parcelas');
  assert.equal((await readKpi(y, 'fin.commissions_provisioned')).value, null);
  await assert.rejects(
    envK.inTx(y, {}, (tx) => require('../../../src/features/analytics/metrics').readMetricAsOf(envK.ctxOf(y), { metricCode: 'fin.commissions_paid', scopeType: 'COMPANY', scopeId: x.companyId, asOfDate: env.asOf }, tx)),
    (e) => e.statusCode === 404, 'o escopo de outra empresa não devolve nada (RLS)'
  );
});

test('m9d623 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  const asserts = require('../_helpers/readModelAsserts');
  const event = { ...envK.event(t, 'finance.commission.created'), payloadJson: { id: envK.ledger.uuid() } };
  const read = async () => ({
    health: Object.fromEntries(Object.entries(await envK.healthRow(env, t)).filter(([k]) => !['refreshed_at', 'source_snapshot_at'].includes(k))),
    snapshots: (await env.admin.query("SELECT d.metric_code, s.dimension_key, s.revision_no, s.value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code IN ('fin.commissions_provisioned', 'fin.commissions_paid') ORDER BY 1, 2, 3", { replacements: { c: t.companyId } }))[0],
  });
  await asserts.assertReplayIdempotent({ applyEvent: () => envK.inTx(t, { commit: true }, (tx) => require('../../../src/features/analytics/read-models').applyEvent(event, tx, { now: envK.NOW })), readRow: read });
});
