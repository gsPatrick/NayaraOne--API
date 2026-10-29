'use strict';

// M9-D672 — sup.complaints_by_reason e sup.sla_resolution: o número refeito do zero só com os casos de atendimento da fonte, o SLA por prioridade (parâmetro do administrador)
// e as regras de qualidade ("Sem motivo" acima de 5% e caso sem prioridade).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d672Env');
const sc = require('../_helpers/m9d672Scenario');
const oracle = require('../_helpers/m9d672Oracle');
const src = require('../_helpers/m9d627Sources');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const MONTH = '2026-10';
let env;
before(async () => {
  env = await kit.setup();
  await sc.reclamacoes(env, env.cX);
  await sc.slas(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d672 reproduz sup.complaints_by_reason a partir dos registros-fonte', async () => {
  const want = await oracle.complaintsFromSource(env, env.cX, MONTH);
  assert.deepEqual(want, { COMPLAINT: 14, CONFLICT: 5 }, '7 + 5 do cenário de reclamações e 7 reclamações do cenário de SLA abertas em outubro; elogio e setembro ficam fora');
  const kpi = await kit.readKpi(env.cX, 'sup.complaints_by_reason');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'sup.complaints_by_reason']);
  assert.equal(Number(kpi.value), 19);
  assert.equal(Number(await kit.dimension(env.cX, 'sup.complaints_by_reason', 'motivo:COMPLAINT:qtd')), 14);
  assert.equal(Number(await kit.dimension(env.cX, 'sup.complaints_by_reason', 'motivo:CONFLICT:qtd')), 5);
  assert.equal(money.cmp(await kit.dimension(env.cX, 'sup.complaints_by_reason', 'motivo:COMPLAINT:pct'), '73.68'), 0);
  assert.equal(kpi.sourceRefs[0].table, 'crm.feedback_cases');
  assert.equal(kpi.sourceRefs[0].count, 19, 'o filtro da origem reproduz o mesmo número');
});

test('m9d672 sup.complaints_by_reason fica DEGRADED com valor nulo quando a regra de qualidade falha ("Sem motivo" acima de 5%)', async () => {
  const t = env.cY;
  await env.admin.query("INSERT INTO analytics.rm_support_complaints (company_id, group_id, month, reason, count, source_snapshot_at) VALUES (:c, :g, '2026-10', 'COMPLAINT', 19, now()), (:c, :g, '2026-10', 'SEM_MOTIVO', 1, now())", { replacements: { c: t.companyId, g: t.groupId } });
  const five = (await kit.kpis(t)).sup.kpis['sup.complaints_by_reason'];
  assert.deepEqual([five.status, five.value], ['OK', '20'], '1 em 20 = 5%: no limite não rebaixa');
  await env.admin.query("UPDATE analytics.rm_support_complaints SET count = 2 WHERE company_id = :c AND reason = 'SEM_MOTIVO'", { replacements: { c: t.companyId } });
  const result = (await kit.kpis(t)).sup.kpis['sup.complaints_by_reason'];
  assert.deepEqual([result.status, result.value, result.details.reason], ['DEGRADED', null, 'MOTIVO_AUSENTE_ACIMA_DO_LIMITE']);
  assert.equal((await kit.readKpi(t, 'sup.complaints_by_reason')).value, null);
  await kit.setSetting(env, t, 'analytics.qualidade.max_sem_motivo_pct', 10); // o limite é parâmetro do administrador
  assert.equal((await kit.kpis(t)).sup.kpis['sup.complaints_by_reason'].status, 'OK');
});

test('m9d672 reproduz sup.sla_resolution a partir dos registros-fonte', async () => {
  const want = await oracle.slaFromSource(env, env.cX, MONTH, kit.NOW);
  assert.deepEqual(want, { resolved: 7, within: 5, openOverdue: 15, pct: '71.43' }, 'abertos vencidos: 12 reclamações e 2 elogios abertos em 05/10 (72 h) e a de prioridade alta aberta em 20/10 (24 h)');
  const kpi = await kit.readKpi(env.cX, 'sup.sla_resolution');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'PERCENT', 1, 'sup.sla_resolution']);
  assert.equal(money.cmp(kpi.value, want.pct), 0, `${kpi.value} x ${want.pct}`);
  assert.equal(Number(await kit.dimension(env.cX, 'sup.sla_resolution', 'resolvidos_qtd')), 7);
  assert.equal(Number(await kit.dimension(env.cX, 'sup.sla_resolution', 'dentro_do_sla_qtd')), 5);
  assert.equal(Number(await kit.dimension(env.cX, 'sup.sla_resolution', 'abertos_vencidos_qtd')), 15, 'abertos já vencidos em destaque');
  assert.equal(Number(await kit.dimension(env.cX, 'sup.sla_resolution', 'prioridade:ALTA:resolvidos_qtd')), 2);
  assert.equal(money.cmp(await kit.dimension(env.cX, 'sup.sla_resolution', 'prioridade:ALTA:dentro_pct'), '50.00'), 0);
  assert.equal(kpi.sourceRefs[0].table, 'crm.feedback_cases');
});

test('m9d672 as horas do SLA por prioridade são parâmetros do administrador (analytics.sla.horas.<prioridade>)', async () => {
  await kit.setSetting(env, env.cX, 'analytics.sla.horas.ALTA', 48); // agora os dois casos de prioridade alta (22 h e 30 h) estão dentro
  await kit.rebuild(env.cX, ['rm_support_sla']);
  const result = (await kit.kpis(env.cX)).sup.kpis['sup.sla_resolution'];
  assert.deepEqual([result.status, result.value], ['OK', '85.71'], '6 de 7');
  await kit.setSetting(env, env.cX, 'analytics.sla.horas.ALTA', 24);
  await kit.rebuild(env.cX, ['rm_support_sla']);
});

test('m9d672 sup.sla_resolution fica DEGRADED com valor nulo quando a regra de qualidade falha (caso sem prioridade usa MEDIA e rebaixa a qualidade)', async () => {
  const t = env.cY;
  await src.feedbackCase(env, t, { type: 'COMPLAINT', severity: 'XPTO', status: 'RESOLVED', at: '2026-10-02T10:00:00Z', resolvedAt: '2026-10-03T10:00:00Z', slaDueAt: '2026-10-05T10:00:00Z' });
  await src.feedbackCase(env, t, { type: 'COMPLAINT', severity: 'HIGH', status: 'RESOLVED', at: '2026-10-02T10:00:00Z', resolvedAt: '2026-10-02T12:00:00Z', slaDueAt: '2026-10-03T10:00:00Z' });
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).sup.kpis['sup.sla_resolution'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.withoutPriority], ['DEGRADED', null, 'CASO_SEM_PRIORIDADE', '1']);
  assert.equal((await kit.readKpi(t, 'sup.sla_resolution')).value, null, 'nunca um número enganoso');
  const row = (await env.admin.query('SELECT resolved, within_sla FROM analytics.rm_support_sla WHERE company_id = :c AND month = :m', { replacements: { c: t.companyId, m: MONTH } }))[0][0];
  assert.deepEqual([row.resolved, row.within_sla], [2, 2], 'o caso sem prioridade foi medido pela prioridade padrão MEDIA (24 h <= 72 h)');
});

test('m9d672 timezone: caso resolvido às 23:30 de São Paulo do último dia do mês pertence ao mês certo', async () => {
  const t = env.cY;
  await src.feedbackCase(env, t, { type: 'COMPLAINT', severity: 'LOW', status: 'RESOLVED', at: '2026-10-31T10:00:00Z', resolvedAt: '2026-11-01T02:30:00Z', slaDueAt: '2026-11-05T10:00:00Z' }); // 31/10 23:30 SP
  await src.feedbackCase(env, t, { type: 'COMPLAINT', severity: 'LOW', status: 'RESOLVED', at: '2026-10-31T10:00:00Z', resolvedAt: '2026-11-01T03:00:00Z', slaDueAt: '2026-11-05T10:00:00Z' }); // 01/11 00:00 SP
  await kit.rebuild(t);
  const october = await oracle.slaFromSource(env, t, MONTH, kit.NOW);
  const november = await oracle.slaFromSource(env, t, '2026-11', kit.NOW);
  assert.deepEqual([october.resolved, november.resolved], [3, 1]);
  const rows = (await env.admin.query('SELECT month, resolved FROM analytics.rm_support_sla WHERE company_id = :c ORDER BY month', { replacements: { c: t.companyId } }))[0];
  assert.deepEqual(rows.map((r) => [r.month, r.resolved]), [['2026-10', 3], ['2026-11', 1]]);
});
