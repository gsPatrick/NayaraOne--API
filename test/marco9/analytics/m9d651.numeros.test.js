'use strict';

// M9-D651 — os três KPIs de atrasos, medições e não conformidades recalculados do zero só com as linhas-fonte (oracle independente), o exemplo do livro,
// o fuso de São Paulo e o replay do evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/obraKpiEnv');
const scenario = require('../_helpers/m9d651Scenario');
const oracle = require('../_helpers/m9d651Oracle');
const asserts = require('../_helpers/readModelAsserts');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const E = scenario.EXPECTED;
let env;
let ids;
before(async () => {
  env = await bi.setup();
  ids = await scenario.seedAll(env, env.tenantA);
});
after(() => bi.teardown(env));

const read = (code, key = '') => bi.readKpi(env.tenantA, code, { dimensionKey: key });
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);

test('m9d651 reproduz obra.delays a partir dos registros-fonte', async () => {
  const facts = await oracle.delaysFacts(env, env.tenantA, bi.AS_OF);
  const kpi = await read('obra.delays');
  assert.deepEqual([kpi.status, kpi.unit], ['OK', 'COUNT']);
  same(kpi.value, facts.count, 'etapas atrasadas = oracle');
  same(kpi.value, E.delays.count, 'exemplo do livro: 3 etapas atrasadas');
  const max = await read('obra.delays', 'maximo_dias');
  const mean = await read('obra.delays', 'medio_dias');
  same(max.value, facts.max, 'maior atraso = oracle');
  same(mean.value, facts.mean, 'atraso médio = oracle');
  same(max.value, E.delays.max, 'exemplo do livro: máximo 12 dias');
  same(mean.value, E.delays.mean, 'exemplo do livro: média 7,7');
  assert.deepEqual([max.unit, mean.unit], ['DAYS', 'DAYS']);
  same((await read('obra.delays', 'obras_com_atraso_qtd')).value, facts.projects, 'obras com pelo menos uma etapa atrasada');
  same((await read('obra.delays', `obra:${ids.delta}`)).value, '2', 'duas etapas atrasadas na Delta');
  same((await read('obra.delays', `obra:${ids.epsilon}:maximo_dias`)).value, '3', 'três dias na Epsilon');
});

test('m9d651 reproduz obra.measurements a partir dos registros-fonte', async () => {
  const facts = await oracle.measurementsFacts(env, env.tenantA, bi.AS_OF);
  const kpi = await read('obra.measurements');
  assert.deepEqual([kpi.status, kpi.unit], ['OK', 'BRL']);
  same(kpi.value, facts.measured, 'medido = oracle');
  same(kpi.value, E.measurements.measured, 'exemplo do livro: medido 220.000,00');
  same((await read('obra.measurements', 'aprovado_brl')).value, facts.approved, 'aprovado = oracle');
  same((await read('obra.measurements', 'aprovado_brl')).value, E.measurements.approved, 'exemplo do livro: aprovado 180.000,00');
  const pending = await read('obra.measurements', 'pendente_brl');
  same(pending.value, facts.pending, 'pendente = oracle');
  same(pending.value, E.measurements.pending, 'exemplo do livro: pendente 40.000,00 (medido - aprovado)');
  const age = await read('obra.measurements', 'pendente_mais_antiga_dias');
  same(age.value, facts.oldestAge, 'idade da pendente mais antiga = oracle');
  same(age.value, E.measurements.oldestAge, 'enviada em 05/10, 23 dias');
  assert.equal(age.unit, 'DAYS');
  assert.equal(facts.withoutPayment, 0);
});

test('m9d651 reproduz obra.nonconformities a partir dos registros-fonte', async () => {
  const facts = await oracle.nonconformityFacts(env, env.tenantA, bi.AS_OF);
  const kpi = await read('obra.nonconformities');
  assert.deepEqual([kpi.status, kpi.unit], ['OK', 'COUNT']);
  same(kpi.value, facts.open, 'abertas na data-base = oracle');
  same(kpi.value, E.nonconformities.open, 'exemplo do livro: 7 abertas');
  same((await read('obra.nonconformities', 'abertas_periodo_qtd')).value, facts.opened, 'abertas no período = oracle');
  same((await read('obra.nonconformities', 'abertas_periodo_qtd')).value, E.nonconformities.opened, 'criadas nos últimos 30 dias');
  const closed = await read('obra.nonconformities', 'fechadas_periodo_qtd');
  same(closed.value, facts.closed, 'fechadas no período = oracle');
  same(closed.value, E.nonconformities.closed, 'exemplo do livro: 11 fechadas');
  const mean = await read('obra.nonconformities', 'tempo_medio_dias');
  same(mean.value, facts.mean, 'tempo médio = oracle');
  same(mean.value, E.nonconformities.mean, 'exemplo do livro: média 9,4 dias');
  assert.deepEqual([closed.unit, mean.unit], ['COUNT', 'DAYS']);
  for (const [cause, open] of Object.entries(facts.byCause)) same((await read('obra.nonconformities', `causa:${cause}`)).value, open, `abertas da causa ${cause}`);
  same((await read('obra.nonconformities', 'equipe:Equipe A')).value, '4', 'abertas da Equipe A');
});

test('m9d651 a leitura traz versão, frescor e rastreio até o registro de origem', async () => {
  const tables = { 'obra.delays': 'construction.project_stages', 'obra.measurements': 'construction.stage_measurements', 'obra.nonconformities': 'construction.nonconformities' };
  for (const [code, table] of Object.entries(tables)) {
    const kpi = await read(code);
    assert.equal(kpi.version, 1);
    assert.ok(kpi.sourceSnapshotAt && kpi.refreshedAt && kpi.freshness.asOfDate === bi.AS_OF, code);
    assert.equal(kpi.sourceRefs[0].table, table, code);
  }
  assert.equal((await read('obra.delays')).sourceRefs[0].count, 3, 'o rastreio conta as mesmas 3 etapas');
  assert.equal((await read('obra.nonconformities')).sourceRefs[0].count, 7);
});

test('m9d651 timezone: etapa que vence às 23:30 de São Paulo (já dia seguinte em UTC) está atrasada um dia', async () => {
  await scenario.stage(env, env.tenantA, ids.epsilon, 2, { ends_at: '2026-10-28T02:30:00Z' }); // 27/10 23:30 em SP
  await bi.refresh(env.tenantA, [{ id: ids.epsilon }]);
  await bi.kpis(env.tenantA);
  const facts = await oracle.delaysFacts(env, env.tenantA, bi.AS_OF);
  same((await read('obra.delays')).value, '4', 'a etapa de 27/10 em SP entra');
  same((await read('obra.delays')).value, facts.count, 'oracle');
  same((await read('obra.delays', 'medio_dias')).value, '6.0', '(12 + 8 + 3 + 1) ÷ 4');
  same((await read('obra.delays', `obra:${ids.epsilon}`)).value, '2', 'duas etapas atrasadas na Epsilon');
});

test('m9d651 replay do mesmo evento não altera o valor', async () => {
  const event = bi.makeEvent(env.tenantA, 'nonconformity.opened', { projectId: ids.delta });
  const snapshot = async () => ({ rows: await bi.rowsOf(env, 'rm_project_nonconformities', env.tenantA), kpis: await Promise.all(bi.CODES.slice(3).map(async (c) => { const k = await read(c); return [c, k.value, k.revisionNo, k.calcHash]; })) });
  const { before } = await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(env.tenantA, event), readRow: snapshot });
  assert.equal((await bi.kpis(env.tenantA)).written, 0, 'calcular de novo sobre o mesmo estado não grava revisão');
  assert.deepEqual(await Promise.all(bi.CODES.slice(3).map(async (c) => { const k = await read(c); return [c, k.value, k.revisionNo, k.calcHash]; })), before.kpis);
});
