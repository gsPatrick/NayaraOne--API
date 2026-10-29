'use strict';

// M9-D660 — legal.deadlines: o número refeito do zero só com os prazos da fonte, a regra de qualidade (prazo sem data), o fuso de São Paulo e o replay.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/legalCorEnv');
const sc = require('../_helpers/m9d660Scenario');
const oracle = require('../_helpers/m9d660Oracle');
const asserts = require('../_helpers/readModelAsserts');

const { AS_OF } = kit;
let env;
let ids;
before(async () => {
  env = await kit.setup();
  ids = await sc.tudo(env, env.cX);
  await kit.refreshAll(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d660 reproduz legal.deadlines a partir dos registros-fonte', async () => {
  const want = await oracle.deadlinesFromSource(env, env.cX, AS_OF);
  assert.deepEqual([want.next7, want.to29, want.overdue, want.beyond, want.oldest], [3, 2, 2, 1, 10], 'o cenário tem as faixas esperadas');
  const kpi = await kit.readKpi(env.cX, 'legal.deadlines');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode, kpi.valueNature], ['OK', 'COUNT', 1, 'legal.deadlines', 'ACTUAL']);
  assert.equal(Number(kpi.value), want.total);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.deadlines', 'proximos_7d_qtd')), want.next7);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.deadlines', 'ate_30d_qtd')), want.to29);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.deadlines', 'vencidos_qtd')), want.overdue);
  assert.equal(Number(await kit.dimension(env.cX, 'legal.deadlines', 'mais_antigo_vencido_dias')), want.oldest);
  assert.ok(kpi.sourceSnapshotAt && kpi.refreshedAt && kpi.sourceRefs.length === 1, 'frescor e origem');
  assert.equal(kpi.sourceRefs[0].table, 'legal.legal_deadlines');
  assert.equal(kpi.sourceRefs[0].count, want.total, 'o filtro da origem reproduz o mesmo número');
});

test('m9d660 as faixas são disjuntas: cada dia de hoje a hoje+29 cai em exatamente uma e hoje+30 em nenhuma', async () => {
  const want = await oracle.deadlinesFromSource(env, env.cX, AS_OF);
  assert.equal(want.next7 + want.to29 + want.overdue + want.beyond, 8, 'os oito prazos abertos estão em exatamente uma faixa (ou além de 30 dias)');
  const kpi = await kit.readKpi(env.cX, 'legal.deadlines');
  assert.equal(Number(kpi.value), 7, 'o prazo de hoje+30 não entra');
  const rm = await kit.query(env, 'SELECT * FROM analytics.rm_legal_deadlines WHERE company_id = :c', { c: env.cX.companyId });
  assert.deepEqual([rm[0].due_next_7d, rm[0].due_7_to_29d, rm[0].overdue, rm[0].open_total], [3, 2, 2, 8]);
});

test('m9d660 legal.deadlines fica INCOMPLETE com valor nulo quando a regra de qualidade falha (prazo sem data) e pede alerta CRITICAL', async () => {
  const t = env.cY;
  await sc.processos(env, t); // empresa Y: só para ter prazos
  await kit.refreshAll(t);
  const first = await kit.kpis(t);
  assert.equal(first.legal.kpis['legal.deadlines'].status, 'OK');
  await env.admin.query('UPDATE analytics.rm_legal_deadlines SET without_date = 1 WHERE company_id = :c', { replacements: { c: t.companyId } });
  const out = await kit.kpis(t);
  const result = out.legal.kpis['legal.deadlines'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.alertSeverity], ['INCOMPLETE', null, 'PRAZO_SEM_DATA', 'CRITICAL']);
  const kpi = await kit.readKpi(t, 'legal.deadlines');
  assert.equal(kpi.value, null, 'nunca um número enganoso');
  assert.ok(['INCOMPLETE', 'DEGRADED'].includes(kpi.status), kpi.status);
});

test('m9d660 timezone: prazo às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  const [c1] = await sc.processos(env, t, { withoutRisk: 0 });
  const d = (due) => kit.seed(env, t, 'legal.legal_deadlines', { legal_case_id: c1, description: 'Fuso', due_at: due, status: 'PENDING', criticality: 'MEDIUM' });
  await d('2026-10-29T02:30:00Z'); // 23:30 de 28/10 em SP (já é 29/10 em UTC): hoje, próximos 7 dias
  await d('2026-10-28T02:30:00Z'); // 23:30 de 27/10 em SP (já é 28/10 em UTC): ontem, vencido
  await d('2026-11-03T02:30:00Z'); // 23:30 de 02/11 em SP: ainda dentro de hoje+6
  const before = await oracle.deadlinesFromSource(env, t, AS_OF);
  assert.equal(oracle.dayOf('2026-10-29T02:30:00Z'), '2026-10-28');
  await kit.refreshAll(t);
  await kit.kpis(t);
  const kpi = await kit.readKpi(t, 'legal.deadlines');
  assert.equal(Number(kpi.value), before.total);
  assert.ok(before.overdue >= 1 && before.next7 >= 2);
  assert.equal(Number(await kit.dimension(t, 'legal.deadlines', 'vencidos_qtd')), before.overdue, 'o das 23:30 de ontem está vencido, não de hoje');
});

test('m9d660 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  const event = kit.makeEvent(t, 'legal.deadline.created', { id: ids.deadlines.d1, legalCaseId: ids.cases[0] });
  const read = async () => ({
    rm: await kit.rowsOf(env, 'rm_legal_deadlines', t),
    snapshots: (await env.admin.query("SELECT d.metric_code, s.dimension_key, s.revision_no, s.value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'legal.deadlines' ORDER BY 1, 2, 3", { replacements: { c: t.companyId } }))[0],
  });
  const { before } = await asserts.assertReplayIdempotent({ applyEvent: () => kit.apply(t, event), readRow: read });
  assert.ok(before.snapshots.length >= 4, 'o evento recalculou o KPI e as dimensões');
});
