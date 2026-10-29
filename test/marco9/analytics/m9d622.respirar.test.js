'use strict';

// M9-D622 — KPI fin.breathing_need (Necessidade para respirar): reprodução a partir dos registros-fonte (exemplo do livro: 13.500,00 e 0,00 com caixa livre de
// 40.000,00), herança de qualidade dos componentes, fuso de São Paulo, isolamento e replay.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envK = require('../_helpers/finKpiEnv');
const sc = require('../_helpers/m9d622Scenario');
const { breathingFromSource } = require('../_helpers/m9d622Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { buildFinanceKpiEntries } = require('../../../src/features/analytics/metrics/kpis/finance.entries');
require('../../../src/features/analytics');

const { refresh, kpis, readKpi } = envK;
const CODE = 'fin.breathing_need';
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
const dim = async (t, key) => (await readKpi(t, CODE, { dimensionKey: key })).value;
const resultOf = async (t) => (await envK.inTx(t, {}, (tx) => buildFinanceKpiEntries({ companyId: t.companyId, groupId: t.groupId }, envK.AS_OF, tx))).find((e) => e.code === CODE).result;
const wipe = (ids) => env.admin.transaction(async (transaction) => {
  await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
  await env.admin.query('DELETE FROM finance.financial_entries WHERE id IN (:ids)', { replacements: { ids }, transaction });
});
let env;
before(async () => {
  env = await envK.setup();
  await sc.seedBreathing(env, env.cX);
  await refresh(env.cX);
  await kpis(env.cX);
});
after(() => envK.teardown(env));

test('m9d622 reproduz fin.breathing_need a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await breathingFromSource(env, t, env.asOf);
  assert.deepEqual([want.overduePayables, want.payables30, want.commissions, want.freeCash, want.need], ['6500.00', '22000.00', '3000.00', '18000.00', '13500.00'], 'exemplo do livro');
  const got = await readKpi(t, CODE);
  same(got.value, want.need, 'valor');
  assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'BRL', 1, 'PROJECTED']);
  assert.ok(got.sourceSnapshotAt && got.refreshedAt);
  same(await dim(t, 'vencido_a_pagar_brl'), want.overduePayables, 'contas a pagar vencidas');
  same(await dim(t, 'a_pagar_30d_brl'), want.payables30, 'contas a pagar em 30 dias');
  same(await dim(t, 'comissoes_brl'), want.commissions, 'comissões sem lançamento');
  same(await dim(t, 'caixa_livre_brl'), want.freeCash, 'caixa livre');
  same((await envK.healthRow(env, t)).breathing_need, want.need, 'o read model guarda o mesmo número');
  assert.deepEqual([...new Set(got.sourceRefs.map((r) => r.component))].sort(), ['fin.commissions_unlinked_30d', 'fin.free_cash', 'fin.overdue_payables', 'fin.payables_30d'], 'cada componente com o seu sourceRefs');
  assert.ok(got.sourceRefs.every((r) => r.table && r.filterHash && Number.isInteger(r.count)));
});

test('m9d622 com o caixa livre cobrindo tudo a necessidade é 0,00 e o texto é "Sem necessidade no horizonte"', async () => {
  const t = env.cY;
  await sc.seedBreathing(env, t, { cash: '40000.00' });
  await refresh(t);
  await kpis(t);
  const want = await breathingFromSource(env, t, env.asOf);
  assert.deepEqual([want.freeCash, want.gross, want.need], ['40000.00', '-8500.00', '0.00']);
  assert.equal((await readKpi(t, CODE)).status, 'OK');
  same((await readKpi(t, CODE)).value, '0.00', 'valor zero');
  same(await dim(t, 'deficit_bruto_brl'), '-8500.00', 'o déficit bruto negativo fica nas dimensões');
  assert.equal((await resultOf(t)).details.text, 'Sem necessidade no horizonte');
});

test('m9d622 fin.breathing_need fica DEGRADED com valor nulo quando a regra de qualidade falha (componente DEGRADED é herdado)', async () => {
  const t = env.cY;
  // conta a pagar sem data de vencimento: contas a pagar vencidas e em 30 dias ficam INCOMPLETE e a necessidade herda
  const noDue = await sc.entry(env, t, { nature: 'PAYABLE', amount: '50.00', due: null });
  await refresh(t);
  await kpis(t);
  const got = await readKpi(t, CODE);
  assert.ok(['DEGRADED', 'INCOMPLETE'].includes(got.status), got.status);
  assert.equal(got.value, null, 'valor nulo, nunca número enganoso');
  const result = await resultOf(t);
  assert.equal(result.details.reason, 'COMPONENTE_DEGRADADO');
  assert.deepEqual(result.details.degradedComponents.map((c) => c.metricCode), ['fin.payables_30d', 'fin.overdue_payables']);
  await wipe([noDue]);
  await refresh(t);
  await kpis(t);
  assert.equal((await readKpi(t, CODE)).status, 'OK', 'sem o lançamento sem vencimento o indicador volta a ter valor');
  // caixa livre DEGRADED (lançamento em revisão manual pendente): o caixa livre é o componente que a necessidade herda
  const review = await envK.ledger.insert(env, 'financial_entries', t, {
    entry_type: 'DEBIT', nature: 'PAYABLE', amount: '1.00', status: 'PENDING', due_at: envK.dayAt(3), is_third_party_funds: false, requires_manual_review: true,
  });
  await refresh(t);
  await kpis(t);
  assert.equal((await readKpi(t, CODE)).value, null);
  assert.deepEqual((await resultOf(t)).details.degradedComponents.map((c) => c.metricCode), ['fin.free_cash']);
  await wipe([review]);
});

test('m9d622 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cX;
  // 27/10 23:30 SP (28/10 02:30Z) venceu em 27/10; 28/10 00:30 SP (03:30Z) vence hoje e é a pagar em 30 dias
  await sc.entry(env, t, { nature: 'PAYABLE', amount: '1.11', due: '2026-10-28T02:30:00.000Z' });
  await sc.entry(env, t, { nature: 'PAYABLE', amount: '2.22', due: '2026-10-28T03:30:00.000Z' });
  await refresh(t);
  await kpis(t);
  const want = await breathingFromSource(env, t, env.asOf);
  assert.deepEqual([want.overduePayables, want.payables30], ['6501.11', '22002.22']);
  same((await readKpi(t, CODE)).value, want.need, 'igual ao recálculo na mão');
  same(await dim(t, 'vencido_a_pagar_brl'), '6501.11', 'o de 23:30 está vencido');
});

test('m9d622 isolamento entre empresas no KPI', async () => {
  const [x, y] = [env.cX, env.cY];
  await assert.rejects(
    envK.inTx(y, {}, (tx) => require('../../../src/features/analytics/metrics').readMetricAsOf(envK.ctxOf(y), { metricCode: CODE, scopeType: 'COMPANY', scopeId: x.companyId, asOfDate: env.asOf }, tx)),
    (e) => e.statusCode === 404, 'o escopo de outra empresa não devolve nada (RLS)'
  );
  assert.notEqual((await readKpi(x, CODE)).value, (await readKpi(y, CODE)).value);
});

test('m9d622 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  const asserts = require('../_helpers/readModelAsserts');
  const event = { ...envK.event(t, 'finance.entry.created'), payloadJson: { id: envK.ledger.uuid() } };
  const read = async () => ({
    health: Object.fromEntries(Object.entries(await envK.healthRow(env, t)).filter(([k]) => !['refreshed_at', 'source_snapshot_at'].includes(k))),
    snapshots: (await env.admin.query(
      `SELECT s.dimension_key, s.revision_no, s.value_numeric::text AS value FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
        WHERE s.company_id = :c AND d.metric_code = :code ORDER BY 1, 2`, { replacements: { c: t.companyId, code: CODE } }))[0],
  });
  await asserts.assertReplayIdempotent({ applyEvent: () => envK.inTx(t, { commit: true }, (tx) => require('../../../src/features/analytics/read-models').applyEvent(event, tx, { now: envK.NOW })), readRow: read });
  same((await readKpi(t, CODE)).value, (await breathingFromSource(env, t, env.asOf)).need, 'valor igual ao recálculo depois do replay');
});
