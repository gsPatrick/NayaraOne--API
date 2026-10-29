'use strict';

// M9-D661 — cor.approval_rate_by_provider e cor.analysis_time: o número refeito do zero só com as decisões da fonte, a amostra mínima, o fuso de São Paulo,
// o envio sem data e a decisão fora do mês.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/legalCorEnv');
const sc = require('../_helpers/m9d661Scenario');
const oracle = require('../_helpers/m9d661Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const MONTH = '2026-10';
let env;
let ids;
before(async () => {
  env = await kit.setup();
  ids = await sc.casos(env, env.cX);
  await kit.refreshAll(env.cX, ids.decided);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d661 reproduz cor.approval_rate_by_provider a partir dos registros-fonte', async () => {
  const want = await oracle.decisionsFromSource(env, env.cX, MONTH);
  assert.deepEqual(want.byProvider, { BANCO_A: { approved: 3, rejected: 2 }, BANCO_B: { approved: 1, rejected: 1 } }, 'a decisão de setembro fica fora');
  const kpi = await kit.readKpi(env.cX, 'cor.approval_rate_by_provider');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'cor.approval_rate_by_provider']);
  assert.equal(Number(kpi.value), want.total);
  const dim = (k) => kit.dimension(env.cX, 'cor.approval_rate_by_provider', k);
  assert.equal(Number(await dim('provider:BANCO_A:aprovadas_qtd')), 3);
  assert.equal(Number(await dim('provider:BANCO_A:rejeitadas_qtd')), 2);
  assert.equal(money.cmp(await dim('provider:BANCO_A:taxa_pct'), '60.00'), 0, 'aprovadas ÷ (aprovadas + rejeitadas) × 100');
  assert.equal(await dim('provider:BANCO_B:taxa_pct'), null, 'banco com 2 decisões (abaixo da amostra de 5) fica sem taxa');
  assert.equal(money.cmp(await dim('taxa_pct'), '57.14'), 0, '4 de 7 no total');
  assert.equal(kpi.sourceRefs[0].count, want.total, 'o filtro da origem reproduz o mesmo número (uma decisão por caso, só o mês)');
});

test('m9d661 cor.approval_rate_by_provider fica INCOMPLETE com valor nulo quando a regra de qualidade falha (amostra insuficiente)', async () => {
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 6); // o mínimo é parâmetro do administrador: nenhum banco chega a 6
  const result = (await kit.kpis(env.cX)).cor.kpis['cor.approval_rate_by_provider'];
  assert.deepEqual([result.status, result.value, result.details.reason], ['INCOMPLETE', null, 'AMOSTRA_INSUFICIENTE']);
  assert.equal((await kit.readKpi(env.cX, 'cor.approval_rate_by_provider')).value, null);
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 2); // agora os dois bancos têm amostra
  const relaxed = (await kit.kpis(env.cX)).cor.kpis['cor.approval_rate_by_provider'];
  assert.equal(relaxed.status, 'OK');
  assert.equal(relaxed.details.byProvider.find((p) => p.provider === 'BANCO_B').rate, '50.00');
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 5);
});

test('m9d661 reproduz cor.analysis_time a partir dos registros-fonte (média em dias de calendário com 1 casa, pendentes à parte)', async () => {
  const want = await oracle.decisionsFromSource(env, env.cX, MONTH);
  const result = (await kit.kpis(env.cX)).cor.kpis['cor.analysis_time'];
  const expected = money.round(money.div(want.days, want.analysed), 1);
  assert.deepEqual([want.days, want.analysed, expected], [32, 7, '4.6'], 'dias entre o envio e a decisão: 2+4+6+8+10 (A) + 2+0 (B)');
  assert.deepEqual([result.status, result.details.decided, result.details.withSendDate, result.details.pending], ['OK', String(want.total), String(want.analysed), '3']);
  assert.equal(money.cmp(result.value, expected), 0, `${result.value} x ${expected}`);
  const kpi = await kit.readKpi(env.cX, 'cor.analysis_time');
  assert.deepEqual([kpi.unit, kpi.status, kpi.version, kpi.metricCode], ['DAYS', 'OK', 1, 'cor.analysis_time']);
  assert.equal(money.cmp(kpi.value, expected), 0);
  assert.equal(Number(await kit.dimension(env.cX, 'cor.analysis_time', 'pendentes_qtd')), 3, 'em análise (2) e enviado (1); o rascunho não conta');
  assert.equal(money.cmp(await kit.dimension(env.cX, 'cor.analysis_time', 'provider:BANCO_A:media_dias'), '6.00'), 0, '(2+4+6+8+10) ÷ 5');
  assert.equal(kpi.sourceRefs[0].count, want.total);
});

test('m9d661 cor.analysis_time fica DEGRADED com valor nulo quando a regra de qualidade falha (decisão sem data de envio)', async () => {
  const t = env.cY;
  const d = await sc.decided(env, t, { provider: 'BANCO_A', outcome: 'APPROVED', sent: null, decidedAt: sc.at('10-06') });
  await sc.decided(env, t, { provider: 'BANCO_A', outcome: 'REJECTED', sent: sc.at('10-01'), decidedAt: sc.at('10-04') });
  await kit.refreshAll(t, [d]);
  const result = (await kit.kpis(t)).cor.kpis['cor.analysis_time'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.withoutSendDate], ['DEGRADED', null, 'ENVIO_SEM_DATA', '1']);
  assert.equal((await kit.readKpi(t, 'cor.analysis_time')).value, null, 'nunca um número enganoso');
});

test('m9d661 timezone: decisão às 23:30 de São Paulo cai no dia certo (e no mês certo)', async () => {
  const t = env.cY;
  // 31/10 às 23:30 em SP = 01/11 02:30Z: a decisão pertence a outubro; o envio em 28/10 às 23:30 SP (29/10 02:30Z) dá 3 dias de calendário
  const id = await sc.decided(env, t, { provider: 'BANCO_C', outcome: 'APPROVED', sent: '2026-10-29T02:30:00Z', decidedAt: '2026-11-01T02:30:00Z' });
  await kit.refreshAll(t, [id]);
  const want = await oracle.decisionsFromSource(env, t, MONTH);
  assert.equal(want.byProvider.BANCO_C.approved, 1, 'em UTC seria novembro');
  const rows = await kit.query(env, "SELECT approved, analysis_days_sum, period_month FROM analytics.rm_fin_provider_outcome WHERE company_id = :c AND provider = 'BANCO_C'", { c: t.companyId });
  assert.deepEqual([rows[0].period_month, rows[0].approved, rows[0].analysis_days_sum], [MONTH, 1, 3]);
});

test('m9d661 replay do mesmo evento não altera o valor', async () => {
  const asserts = require('../_helpers/readModelAsserts');
  const t = env.cX;
  const event = kit.makeEvent(t, 'financing.approved', { id: ids.decided[0] });
  const read = async () => ({
    rm: await kit.rowsOf(env, 'rm_fin_provider_outcome', t),
    snapshots: (await env.admin.query("SELECT d.metric_code, s.dimension_key, s.revision_no, s.value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code IN ('cor.approval_rate_by_provider', 'cor.analysis_time') ORDER BY 1, 2, 3", { replacements: { c: t.companyId } }))[0],
  });
  await asserts.assertReplayIdempotent({ applyEvent: () => kit.apply(t, event), readRow: read });
});
