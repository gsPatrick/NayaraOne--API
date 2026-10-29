'use strict';

// M9-D660 — legal.cases_by_risk e legal.values: o número refeito do zero só com os processos da fonte, a regra de qualidade (sem classificação), as duas séries
// (estimado e confirmado) que nunca se somam, o processo sem valor que não vira zero e o ciclo de vida do processo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/legalCorEnv');
const sc = require('../_helpers/m9d660Scenario');
const oracle = require('../_helpers/m9d660Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

let env;
const refreshCases = (t) => kit.apply(t, kit.makeEvent(t, 'legal.case.updated', { id: kit.uuid() }));
before(async () => {
  env = await kit.setup();
  await sc.tudo(env, env.cX);
  await kit.refreshAll(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d660 reproduz legal.cases_by_risk a partir dos registros-fonte', async () => {
  const want = await oracle.casesFromSource(env, env.cX);
  assert.deepEqual(want.byRisk, { HIGH: 3, MEDIUM: 4, LOW: 2, SEM_CLASSIFICACAO: 1 });
  const kpi = await kit.readKpi(env.cX, 'legal.cases_by_risk');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'legal.cases_by_risk']);
  assert.equal(Number(kpi.value), want.total);
  for (const [risk, n] of Object.entries(want.byRisk)) assert.equal(Number(await kit.dimension(env.cX, 'legal.cases_by_risk', `risco:${risk}`)), n, risk);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.cases_by_risk', 'tipo:EVICTION')), 3);
  assert.equal(kpi.sourceRefs[0].count, want.total, 'o filtro da origem reproduz o mesmo número (encerrado, arquivado e excluído ficam fora)');
});

test('m9d660 legal.cases_by_risk fica DEGRADED com valor nulo quando a regra de qualidade falha (sem classificação acima do limite)', async () => {
  const t = env.cY;
  await sc.processos(env, t, { withoutRisk: 3 }); // 3 de 12 = 25% sem nível, acima dos 10% padrão
  await kit.refreshAll(t);
  const out = await kit.kpis(t);
  const result = out.legal.kpis['legal.cases_by_risk'];
  assert.deepEqual([result.status, result.value, result.details.reason], ['DEGRADED', null, 'SEM_CLASSIFICACAO_ACIMA_DO_LIMITE']);
  assert.equal((await kit.readKpi(t, 'legal.cases_by_risk')).value, null, 'nunca um número enganoso');
  await kit.setSetting(env, t, 'analytics.qualidade.max_sem_risco_pct', 30); // o limite é parâmetro do administrador
  const relaxed = (await kit.kpis(t)).legal.kpis['legal.cases_by_risk'];
  assert.deepEqual([relaxed.status, relaxed.value], ['OK', '12']);
});

test('m9d660 reproduz legal.values a partir dos registros-fonte', async () => {
  const want = await oracle.casesFromSource(env, env.cX);
  assert.deepEqual([want.estimated, want.confirmed, want.withoutValue], ['501000.50', '127000.00', 2]);
  const kpi = await kit.readKpi(env.cX, 'legal.values');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode, kpi.valueNature], ['OK', 'BRL', 1, 'legal.values', 'ESTIMATED']);
  assert.equal(money.cmp(kpi.value, want.estimated), 0, `${kpi.value} x ${want.estimated}`);
  assert.equal(money.cmp(await kit.dimension(env.cX, 'legal.values', 'confirmado_brl'), want.confirmed), 0);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.values', 'sem_valor_qtd')), want.withoutValue);
  assert.equal(kpi.sourceRefs[0].table, 'legal.legal_cases');
  assert.equal(kpi.sourceRefs[0].count, want.total, 'o filtro da origem reproduz os mesmos processos');
});

test('m9d660 legal.values não tem regra que anule o valor: o processo sem valor é contado, o indicador continua OK', async () => {
  const out = await kit.kpis(env.cX);
  const result = out.legal.kpis['legal.values'];
  assert.equal(result.status, 'OK');
  assert.equal(result.details.withoutValue, '2');
});

test('m9d660 legal.values mantém estimado (ESTIMATED) e confirmado (ACTUAL) como séries separadas e nunca somadas', async () => {
  const result = (await kit.kpis(env.cX)).legal.kpis['legal.values'];
  const series = result.details.series;
  assert.deepEqual(series.map((s) => [s.valueNature, s.total]), [['ACTUAL', '127000.00'], ['ESTIMATED', '501000.50']]);
  assert.equal(result.value, '501000.50', 'o valor do indicador é só o estimado');
  assert.ok(!JSON.stringify(result).includes('628000.50'), 'não existe total das duas séries (501000.50 + 127000.00)');
});

test('m9d660 legal.values conta processo ativo sem valor estimado em details.withoutValue e não o trata como zero', async () => {
  const t = env.cY;
  const before = (await kit.kpis(t)).legal.kpis['legal.values'];
  await kit.seed(env, t, 'legal.legal_cases', { status: 'OPEN', case_type: 'LABOR', risk_level: 'LOW' });
  await refreshCases(t);
  const after2 = (await kit.kpis(t)).legal.kpis['legal.values'];
  assert.equal(after2.details.withoutValue, String(Number(before.details.withoutValue) + 1));
  assert.equal(after2.value, before.value, 'o estimado não muda: nulo não vira zero nem soma');
});

test('m9d660 legal.values: processo encerrado sai do estimado e condenação confirmada entra no confirmado', async () => {
  const t = env.cY;
  const before = (await kit.kpis(t)).legal.kpis['legal.values'];
  const [row] = await kit.query(env, "SELECT id, estimated_amount::text AS amount FROM legal.legal_cases WHERE company_id = :c AND estimated_amount = 50000 AND deleted_at IS NULL LIMIT 1", { c: t.companyId });
  await kit.update(env, 'legal.legal_cases', row.id, { phase: 'CLOSED', confirmed_amount: '30000.00' }); // sentença: encerrado, com condenação confirmada
  await refreshCases(t);
  const after2 = (await kit.kpis(t)).legal.kpis['legal.values'];
  assert.equal(money.cmp(after2.value, money.sub(before.value, '50000.00')), 0, 'saiu do estimado');
  const conf = (a) => a.details.series.find((s) => s.valueNature === 'ACTUAL').total;
  assert.equal(money.cmp(conf(after2), money.add(conf(before), '30000.00')), 0, 'entrou no confirmado');
});
