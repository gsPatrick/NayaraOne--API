'use strict';

// M9-D660 — legal.missing_documents: o número refeito do zero só com as exigências da fonte e a regra de qualidade (exigência sem prazo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/legalCorEnv');
const sc = require('../_helpers/m9d660Scenario');
const oracle = require('../_helpers/m9d660Oracle');

let env;
let ids;
before(async () => {
  env = await kit.setup();
  ids = await sc.tudo(env, env.cX);
  for (const c of [ids.reqs.c1, ids.reqs.c2]) await kit.update(env, 'legal.contracts', c, { starts_at: sc.at('11-01') }); // com início de vigência: todas as exigências têm prazo
  await kit.refreshAll(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d660 reproduz legal.missing_documents a partir dos registros-fonte', async () => {
  const want = await oracle.missingFromSource(env, env.cX);
  assert.deepEqual([want.requirements, want.contracts, want.without_deadline], [4, 2, 0], 'contrato cancelado e excluído ficam fora; atendida e dispensada não contam');
  const kpi = await kit.readKpi(env.cX, 'legal.missing_documents');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'legal.missing_documents']);
  assert.equal(Number(kpi.value), want.requirements);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.missing_documents', 'contratos_qtd')), want.contracts);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.missing_documents', 'tipo:IDENTIFICATION')), 3);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.missing_documents', 'tipo:PROOF_OF_INCOME')), 1);
  assert.equal(kpi.sourceRefs[0].table, 'legal.contract_requirements');
  assert.equal(kpi.sourceRefs[0].count, want.requirements, 'o filtro da origem reproduz o mesmo número');
});

test('m9d660 legal.missing_documents fica DEGRADED com valor nulo quando a regra de qualidade falha (exigência sem prazo)', async () => {
  const t = env.cY;
  const other = await sc.tudo(env, t); // os contratos desta empresa não têm início de vigência
  const want = await oracle.missingFromSource(env, t);
  assert.equal(want.without_deadline, want.requirements);
  await kit.refreshAll(t);
  const result = (await kit.kpis(t)).legal.kpis['legal.missing_documents'];
  assert.deepEqual([result.status, result.value, result.details.reason], ['DEGRADED', null, 'EXIGENCIA_SEM_PRAZO']);
  assert.equal((await kit.readKpi(t, 'legal.missing_documents')).value, null);
  await kit.setSetting(env, t, 'analytics.qualidade.max_exigencia_sem_prazo_pct', 100); // o limite é parâmetro do administrador
  const relaxed = (await kit.kpis(t)).legal.kpis['legal.missing_documents'];
  assert.deepEqual([relaxed.status, relaxed.value], ['OK', String(want.requirements)]);
  assert.ok(other.reqs.c1);
});
