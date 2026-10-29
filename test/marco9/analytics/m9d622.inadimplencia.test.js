'use strict';

// M9-D622 — KPIs fin.overdue_receivables e fin.delinquency_rate: reprodução a partir dos registros-fonte (exemplos do livro), qualidade (vencimento ausente, base
// zero), janela e faixas do administrador, fuso de São Paulo, isolamento e replay.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envK = require('../_helpers/finKpiEnv');
const sc = require('../_helpers/m9d622Scenario');
const { delinquencyFromSource, withoutDueDate } = require('../_helpers/m9d622Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const { buildFinanceKpiEntries } = require('../../../src/features/analytics/metrics/kpis/finance.entries');
require('../../../src/features/analytics');

const { refresh, kpis, readKpi, dayAt, setSetting } = envK;
const OVERDUE = 'fin.overdue_receivables';
const RATE = 'fin.delinquency_rate';
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
const dim = async (t, code, key) => (await readKpi(t, code, { dimensionKey: key })).value;
const resultOf = async (t, code) => (await envK.inTx(t, {}, (tx) => buildFinanceKpiEntries({ companyId: t.companyId, groupId: t.groupId }, envK.AS_OF, tx))).find((e) => e.code === code).result;
const wipe = (ids) => env.admin.transaction(async (transaction) => {
  await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
  await env.admin.query('DELETE FROM finance.financial_entries WHERE id IN (:ids)', { replacements: { ids }, transaction });
});
let env;
before(async () => {
  env = await envK.setup();
  await sc.seedOverdue(env, env.cX);
  await refresh(env.cX);
  await kpis(env.cX);
});
after(() => envK.teardown(env));

test('m9d622 reproduz fin.overdue_receivables a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await delinquencyFromSource(env, t, env.asOf);
  assert.equal(want.total, '25000.00', 'exemplo do livro: 12.000,00 + 4.000,00 na janela e 9.000,00 há 120 dias');
  const got = await readKpi(t, OVERDUE);
  same(got.value, want.total, 'valor');
  assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'BRL', 1, 'ACTUAL']);
  assert.ok(got.sourceSnapshotAt && got.refreshedAt);
  assert.equal(got.sourceRefs[0].table, 'finance.financial_entries');
  assert.equal(got.sourceRefs[0].count, want.count, 'o sourceRefs conta as mesmas linhas do valor');
  for (const [band, amount] of Object.entries(want.bands)) same(await dim(t, OVERDUE, `faixa:${band}`), amount, `faixa ${band}`);
  assert.deepEqual(Object.keys(want.bands), ['1-30', '31-60', '61-90', '90+']);
  for (const [contract, amount] of Object.entries(want.contracts)) same(await dim(t, OVERDUE, `contrato:${contract}`), amount, 'contrato');
  same(await dim(t, OVERDUE, 'dentro_janela_brl'), '16000.00', 'dentro da janela');
  same(await dim(t, OVERDUE, 'fora_janela_brl'), '9000.00', 'fora da janela');
  same(await dim(t, OVERDUE, 'quantidade_qtd'), '3', 'quantidade de entradas vencidas');
});

test('m9d622 fin.overdue_receivables fica DEGRADED com valor nulo quando a regra de qualidade falha (vencimento ausente é INCOMPLETE)', async () => {
  const t = env.cY;
  const id = await sc.entry(env, t, { amount: '20.00', due: null });
  await sc.entry(env, t, { amount: '30.00', due: dayAt(-3) });
  await refresh(t);
  await kpis(t);
  const got = await readKpi(t, OVERDUE);
  assert.equal(got.status, 'INCOMPLETE');
  assert.equal(got.value, null, 'valor nulo, nunca número enganoso');
  assert.equal(await withoutDueDate(env, t, 'RECEIVABLE'), 1);
  const result = await resultOf(t, OVERDUE);
  assert.deepEqual([result.details.reason, result.details.withoutDueDate, result.message], ['LANCAMENTO_SEM_VENCIMENTO', '1', 'Dado incompleto, valor não confiável.']);
  await wipe([id]);
  await refresh(t);
  await kpis(t);
  const back = await readKpi(t, OVERDUE);
  assert.equal(back.status, 'OK');
  same(back.value, '30.00', 'sem a entrada sem vencimento o indicador volta a ter valor');
});

test('m9d622 reproduz fin.delinquency_rate a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await delinquencyFromSource(env, t, env.asOf);
  assert.deepEqual([want.inWindow, want.base, want.rate, want.outside], ['16000.00', '200000.00', '8.00', '9000.00'], 'exemplo do livro: 8,00% e 9.000,00 fora da janela');
  const got = await readKpi(t, RATE);
  same(got.value, want.rate, 'taxa');
  assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'PERCENT', 1, 'ACTUAL']);
  assert.equal(got.sourceRefs[0].table, 'finance.financial_entries');
  same(await dim(t, RATE, 'vencido_janela_brl'), want.inWindow, 'vencido na janela');
  same(await dim(t, RATE, 'base_brl'), want.base, 'base');
  same(await dim(t, RATE, 'fora_janela_brl'), want.outside, 'details.overdueOutsideWindow');
  same(await dim(t, RATE, 'faixa:1-30'), '6.00', 'faixa 1-30');
  same(await dim(t, RATE, 'faixa:61-90'), '2.00', 'faixa 61-90');
  same(await dim(t, RATE, 'faixa:90+'), '0.00', 'a dívida de 120 dias não entra na taxa');
  same(await dim(t, RATE, `contrato:${sc.CONTRACT.one}`), '6.00', 'contrato 1');
  same((await readKpi(t, OVERDUE)).value, '25000.00', 'o total sem limite de idade continua em fin.overdue_receivables');
  assert.ok(Number(got.value) <= 100);
});

test('m9d622 fin.delinquency_rate fica DEGRADED com valor nulo quando a regra de qualidade falha (base zero é INCOMPLETE)', async () => {
  // empresa sem nenhuma entrada própria na janela: a base é zero (e o valor inadimplente é 0,00, sem problema)
  const t = env.cY;
  const ids = (await env.admin.query('SELECT id FROM finance.financial_entries WHERE company_id = :c', { replacements: { c: t.companyId } }))[0].map((r) => r.id);
  await wipe(ids);
  await refresh(t);
  await kpis(t);
  const got = await readKpi(t, RATE);
  assert.equal(got.status, 'INCOMPLETE');
  assert.equal(got.value, null, 'nunca 0% quando não há base');
  assert.equal((await resultOf(t, RATE)).details.reason, 'BASE_ZERO');
  same((await readKpi(t, OVERDUE)).value, '0.00', 'valor inadimplente zero é um valor');
  // vencimento ausente também impede a taxa
  const id = await sc.entry(env, t, { amount: '10.00', due: null });
  await sc.entry(env, t, { amount: '90.00', due: dayAt(-3) });
  await refresh(t);
  await kpis(t);
  assert.equal((await readKpi(t, RATE)).status, 'INCOMPLETE');
  assert.equal((await resultOf(t, RATE)).details.reason, 'LANCAMENTO_SEM_VENCIMENTO');
  await wipe([id]);
  await refresh(t);
  await kpis(t);
  same((await readKpi(t, RATE)).value, '100.00', 'tudo vencido e na janela: 100,00%, o teto');
});

test('m9d622 a janela analytics.inadimplencia.janela_dias e as faixas analytics.inadimplencia.faixas_atraso_dias vêm do administrador', async () => {
  const t = env.cX;
  await setSetting(env, t, 'analytics.inadimplencia.janela_dias', 60);
  await refresh(t);
  await kpis(t);
  const want = await delinquencyFromSource(env, t, env.asOf, { windowDays: 60 });
  assert.deepEqual([want.inWindow, want.base, want.outside], ['12000.00', '196000.00', '13000.00'], 'com 60 dias os 4.000,00 de 70 dias saem da janela');
  same((await readKpi(t, RATE)).value, want.rate, 'taxa com a janela de 60 dias');
  same(await dim(t, RATE, 'fora_janela_brl'), '13000.00', 'fora da janela');
  same((await readKpi(t, OVERDUE)).value, '25000.00', 'o valor inadimplente não depende da janela');
  await setSetting(env, t, 'analytics.inadimplencia.janela_dias', 90);
  await setSetting(env, t, 'analytics.inadimplencia.faixas_atraso_dias', '15,45');
  await refresh(t);
  await kpis(t);
  const custom = await delinquencyFromSource(env, t, env.asOf, { limits: [15, 45] });
  assert.deepEqual(Object.keys(custom.bands), ['1-15', '16-45', '45+']);
  for (const [band, amount] of Object.entries(custom.bands)) same(await dim(t, OVERDUE, `faixa:${band}`), amount, `faixa ${band}`);
  await setSetting(env, t, 'analytics.inadimplencia.faixas_atraso_dias', '30,60,90');
  await refresh(t);
  await kpis(t);
});

test('m9d622 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  const ids = (await env.admin.query('SELECT id FROM finance.financial_entries WHERE company_id = :c', { replacements: { c: t.companyId } }))[0].map((r) => r.id);
  await wipe(ids);
  // 27/10 23:30 SP = 28/10 02:30Z (já no dia seguinte em UTC): venceu em 27/10, está vencido em 28/10
  await sc.entry(env, t, { amount: '1.11', due: '2026-10-28T02:30:00.000Z' });
  // 28/10 00:30 SP = 28/10 03:30Z: vence hoje, não está vencido; 28/10 23:30 SP = 29/10 02:30Z também vence hoje
  await sc.entry(env, t, { amount: '2.22', due: '2026-10-28T03:30:00.000Z' });
  await sc.entry(env, t, { amount: '4.44', due: '2026-10-29T02:30:00.000Z' });
  await refresh(t);
  await kpis(t);
  const want = await delinquencyFromSource(env, t, env.asOf);
  assert.equal(want.total, '1.11', 'o recálculo independente, na mão, concorda');
  same((await readKpi(t, OVERDUE)).value, '1.11', 'só o que venceu em 27/10 está vencido');
  same((await readKpi(t, RATE)).value, want.rate, 'a taxa usa o mesmo corte');
});

test('m9d622 isolamento entre empresas no KPI', async () => {
  const [x, y] = [env.cX, env.cY];
  same((await readKpi(x, OVERDUE)).value, '25000.00', 'X só vê os próprios lançamentos');
  for (const code of [OVERDUE, RATE]) {
    await assert.rejects(
      envK.inTx(y, {}, (tx) => require('../../../src/features/analytics/metrics').readMetricAsOf(envK.ctxOf(y), { metricCode: code, scopeType: 'COMPANY', scopeId: x.companyId, asOfDate: env.asOf }, tx)),
      (e) => e.statusCode === 404, 'o escopo de outra empresa não devolve nada (RLS)'
    );
  }
});

test('m9d622 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  const asserts = require('../_helpers/readModelAsserts');
  const event = { ...envK.event(t, 'finance.entry.created'), payloadJson: { id: envK.ledger.uuid() } };
  const read = async () => {
    const health = Object.fromEntries(Object.entries(await envK.healthRow(env, t)).filter(([k]) => !['refreshed_at', 'source_snapshot_at'].includes(k)));
    const snapshots = (await env.admin.query(
      `SELECT d.metric_code, s.dimension_key, s.revision_no, s.value_numeric::text AS value FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
        WHERE s.company_id = :c AND d.metric_code IN (:codes) ORDER BY 1, 2, 3`, { replacements: { c: t.companyId, codes: [OVERDUE, RATE] } }))[0];
    return { health, snapshots };
  };
  await asserts.assertReplayIdempotent({ applyEvent: () => envK.inTx(t, { commit: true }, (tx) => require('../../../src/features/analytics/read-models').applyEvent(event, tx, { now: envK.NOW })), readRow: read });
  same((await readKpi(t, OVERDUE)).value, '25000.00', 'valor igual depois do replay');
  assert.ok(Object.keys(await envK.healthRow(env, t)).includes('overdue_receivables_detail'));
});
