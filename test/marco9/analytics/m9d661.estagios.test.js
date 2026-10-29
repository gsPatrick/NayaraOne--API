'use strict';

// M9-D661 — cor.cases_by_stage: o número refeito do zero só com os casos da fonte, o tempo médio no estágio, o estágio inválido e a regra de qualidade (caso sem estágio).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/legalCorEnv');
const sc = require('../_helpers/m9d661Scenario');
const oracle = require('../_helpers/m9d661Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const { AS_OF } = kit;
let env;
const stage = (t) => kit.apply(t, kit.makeEvent(t, 'financing.status.changed', { id: kit.uuid() }));
before(async () => {
  env = await kit.setup();
  await sc.casos(env, env.cX);
  await kit.refreshAll(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d661 reproduz cor.cases_by_stage a partir dos registros-fonte', async () => {
  const want = await oracle.stagesFromSource(env, env.cX, AS_OF);
  assert.deepEqual(Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v.count])), { APPROVED: 5, REJECTED: 3, UNDER_ANALYSIS: 2, SUBMITTED: 1, DRAFT: 1 });
  const total = Object.values(want).reduce((a, v) => a + v.count, 0);
  const kpi = await kit.readKpi(env.cX, 'cor.cases_by_stage');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'cor.cases_by_stage']);
  assert.equal(Number(kpi.value), total);
  for (const [name, v] of Object.entries(want)) {
    assert.equal(Number(await kit.dimension(env.cX, 'cor.cases_by_stage', `estagio:${name}`)), v.count, name);
    const avg = money.round(money.div(v.days, v.count), 1);
    assert.equal(money.cmp(await kit.dimension(env.cX, 'cor.cases_by_stage', `estagio:${name}:tempo_medio_dias`), avg), 0, `tempo médio em ${name}`);
  }
  assert.equal(kpi.sourceRefs[0].table, 'correspondent.financing_cases');
  assert.equal(kpi.sourceRefs[0].count, total, 'o filtro da origem reproduz o mesmo número');
});

test('m9d661 estágio fora da lista válida entra no total e em details.invalid (parâmetro do administrador)', async () => {
  const t = env.cY;
  await sc.fcase(env, t, 'UNDER_ANALYSIS');
  await sc.fcase(env, t, 'DRAFT');
  await stage(t);
  const normal = (await kit.kpis(t)).cor.kpis['cor.cases_by_stage'];
  assert.deepEqual([normal.status, normal.value, normal.details.invalid.count], ['OK', '2', '0']);
  await kit.setSetting(env, t, 'analytics.correspondente.estagios_validos', 'DRAFT'); // o administrador só reconhece o rascunho como estágio válido
  const result = (await kit.kpis(t)).cor.kpis['cor.cases_by_stage'];
  assert.deepEqual([result.status, result.value, result.details.invalid.count, result.details.invalid.stages], ['OK', '2', '1', ['UNDER_ANALYSIS']]);
});

test('m9d661 cor.cases_by_stage fica DEGRADED com valor nulo quando a regra de qualidade falha (caso sem estágio)', async () => {
  const t = env.cY;
  // o banco já recusa status fora do domínio (financing_cases_status_domain): a regra é provada sobre o read model, com uma linha sem estágio
  await env.admin.query("INSERT INTO analytics.rm_fin_cases_stage (company_id, group_id, stage, count, days_in_stage_sum, source_snapshot_at) VALUES (:c, :g, '', 1, 0, now())", { replacements: { c: t.companyId, g: t.groupId } });
  const result = (await kit.kpis(t)).cor.kpis['cor.cases_by_stage'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.withoutStage], ['DEGRADED', null, 'CASO_SEM_ESTAGIO', '1']);
  assert.equal((await kit.readKpi(t, 'cor.cases_by_stage')).value, null, 'nunca um número enganoso');
});
