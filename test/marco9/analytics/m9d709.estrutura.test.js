'use strict';

// M9-D709 — estrutura da fila de decisão: colunas e RLS do read model, ordenação e marca de envelhecido, parâmetros do administrador (limite de envelhecimento e owner),
// mapa de eventos, agenda de 15 minutos (evento ausente nunca deixa a fila errada), registry/semente (v1, CRITICAL, origem e detalhe). Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d709Env');
require('../../../src/features/analytics'); // entrada real do BI: registra o read model e liga os KPIs
const readModels = require('../../../src/features/analytics/read-models');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const settings = require('../../../src/features/settings/settings.service');
const { getFormulaCatalog } = require('../../../src/features/analytics/metrics/formulaCatalog');
const { detailOf } = require('../../../src/features/analytics/metrics/drilldown.details');

let env;
before(async () => { env = await e.setup(); });
after(() => e.teardown(env));

const COLUMNS = ['id', 'company_id', 'group_id', 'kind', 'source_type', 'source_id', 'title', 'amount', 'requested_at', 'requested_by', 'owner_role', 'status', 'decided_at', 'source_event_id', 'source_snapshot_at', 'refreshed_at', 'version'];
const list = (t, options, permissions = e.PERMS) => e.bi.inTx(t, {}, (tx) => readModels.listDecisionQueue({ companyId: t.companyId, groupId: t.groupId, permissions }, { now: e.bi.NOW, ...options }, tx));

test('m9d709 read model tem as colunas do livro, chave única por kind e source_id, RLS FORCE e rebuild registrado', async () => {
  const [cols] = await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'rm_decision_queue'");
  const names = cols.map((c) => c.column_name);
  for (const c of COLUMNS) assert.ok(names.includes(c), `falta a coluna ${c}`);
  const [[rls]] = await env.admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'analytics.rm_decision_queue'::regclass");
  assert.deepEqual([rls.relrowsecurity, rls.relforcerowsecurity], [true, true]);
  const def = readModels.getReadModel('rm_decision_queue');
  assert.deepEqual(def.keyColumns, ['kind', 'source_id']);
  assert.equal(typeof def.rebuild.keys, 'function');
  assert.equal(typeof def.scheduled.keys, 'function');
  const t = env.cX;
  const id = await e.finApproval(env, t, { amount: '5.00' });
  await e.applyKind(t, 'FIN_APPROVAL', id);
  await assert.rejects(env.admin.query(
    "INSERT INTO analytics.rm_decision_queue (company_id, group_id, kind, source_type, source_id, title, owner_role) VALUES (:c, :g, 'FIN_APPROVAL', 'x', :s, 't', 'o')",
    { replacements: { c: t.companyId, g: t.groupId, s: id } }
  ), (err) => err.name === 'SequelizeUniqueConstraintError');
});

test('m9d709 fila ordena do mais antigo ao mais novo e marca o envelhecido pelo limite do administrador', async () => {
  const t = env.cY;
  const a = await e.finApproval(env, t, { amount: '10.00', hours: 80 });
  const b = await e.finApproval(env, t, { amount: '20.00', hours: 48 });
  const c = await e.finApproval(env, t, { amount: '30.00', hours: 3 });
  const d = await e.nayRecommendation(env, t, { hours: 49 });
  for (const id of [c, a, b]) await e.applyKind(t, 'FIN_APPROVAL', id);
  await e.applyKind(t, 'NAY_PROPOSAL', d);
  const out = await list(t);
  assert.deepEqual(out.items.map((i) => i.sourceId), [a, d, b, c], 'idade decrescente: 80 h, 49 h, 48 h, 3 h');
  assert.deepEqual(out.items.map((i) => i.aged), [true, true, false, false], 'acima de 48 h é envelhecido; 48 h exatas não');
  assert.deepEqual([out.total, out.agedHours, out.items[0].ageHours, out.items[0].amount], [4, 48, 80, '10.00']);
  assert.equal((await list(t, { limit: 2 })).items.length, 2);
  assert.equal((await list(t, { kind: 'NAY_PROPOSAL' })).items.length, 1);
  await assert.rejects(list(t, {}, []), (err) => err.code === 'PERMISSION_DENIED');
  assert.deepEqual((await list(t, {}, ['analytics:read', 'finance:read'])).items.map((i) => i.kind), ['FIN_APPROVAL', 'FIN_APPROVAL', 'FIN_APPROVAL'], 'sem a permissão do domínio a fila não aparece');
  await e.bi.setSetting(env, t, 'analytics.centro.decisao_atraso_horas', 100);
  assert.deepEqual((await list(t)).items.map((i) => i.aged), [false, false, false, false], 'o limite é parâmetro do administrador');
  await e.bi.setSetting(env, t, 'analytics.centro.decisao_atraso_horas', 50);
  assert.deepEqual((await list(t)).items.map((i) => i.aged), [true, false, false, false]);
  await e.materialize(t);
  const aged = await env.admin.query("SELECT value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'fin.approvals_pending' AND s.dimension_key = 'envelhecidas_qtd'", { replacements: { c: t.companyId } });
  assert.equal(Number(aged[0][0].v), 1, 'o KPI conta as envelhecidas pelo mesmo parâmetro');
});

test('m9d709 owner de cada KPI segue o parâmetro da empresa e o limite tem faixa validada', async () => {
  const t = env.cX;
  await e.bi.setSetting(env, t, 'analytics.owner.tec.rule_approvals_pending', 'Segurança (papel seguranca-gestor)');
  await e.applyKind(t, 'RULE_APPROVAL', (await e.ruleApproval(env, t)).id);
  await e.materialize(t);
  const res = await e.get(env, 'tec.rule_approvals_pending');
  assert.equal(res.body.data.owner, 'Segurança (papel seguranca-gestor)');
  const row = (await e.queueRows(env, t, "AND kind = 'RULE_APPROVAL'"))[0];
  assert.equal(row.owner_role, 'Segurança (papel seguranca-gestor)');
  const schema = settings.SETTINGS_SCHEMA;
  for (const key of ['analytics.centro.decisao_atraso_horas', ...e.KPI_CODES.map((k) => `analytics.owner.${k}`)]) assert.ok(schema[key], `${key} no SETTINGS_SCHEMA`);
  assert.deepEqual([schema['analytics.centro.decisao_atraso_horas'].min, schema['analytics.centro.decisao_atraso_horas'].max], [1, 8760]);
});

test('m9d709 mapa de eventos traduz o nome real e ignora o que não é da fila', async () => {
  const t = env.cX;
  const id = await e.finApproval(env, t, { amount: '1.00' });
  const created = await e.bi.apply(t, e.bi.makeEvent(t, 'finance.approval_step.decided', { id: e.uuid(), approvalRequestId: id, decision: 'APPROVED' }));
  assert.equal(created.upserted, 1, 'finance.approval_step.decided é traduzido para o pedido');
  assert.equal((await e.queueRows(env, t, `AND source_id = '${id}'`)).length, 1);
  const bad = await e.bi.apply(t, e.bi.makeEvent(t, 'finance.approval_request.created', { id: 'nao-e-uuid' }));
  assert.equal(bad.upserted, 0);
  const none = await e.bi.apply(t, e.bi.makeEvent(t, 'finance.approval_request.created', { id: e.uuid() }));
  assert.equal(none.upserted, 0, 'pedido que não existe na fonte e não está na fila não cria linha');
});

test('m9d709 agenda de 15 minutos: evento ausente atrasa a fila e nunca a deixa errada', async () => {
  const t = env.cY;
  const quiet = await e.invProposal(env, t, { quantity: '2', cost: '5.00' }); // nenhum evento chegou
  assert.equal((await e.queueRows(env, t, `AND source_id = '${quiet}'`)).length, 0);
  await e.bi.runSchedule(t, e.bi.NOW);
  const row = (await e.queueRows(env, t, `AND source_id = '${quiet}'`))[0];
  assert.deepEqual([row.status, row.amount, row.kind], ['PENDING', '10.00', 'INV_ADJUSTMENT'], 'a agenda trouxe o item e o valor');
  await env.admin.query("UPDATE inventory.adjustment_proposals SET status = 'APPROVED', decided_at = :now WHERE id = :id", { replacements: { id: quiet, now: e.bi.NOW.toISOString() } }); // decisão sem evento
  await e.bi.runSchedule(t, e.bi.NOW);
  assert.equal((await e.queueRows(env, t, `AND source_id = '${quiet}'`))[0].status, 'DECIDED', 'a agenda fecha o item decidido');
});

test('m9d709 as 4 métricas: registry v1 CRITICAL com origem, detalhe, dimensões e owner; a semente publica a v1 global', async () => {
  const rows = seed.listCriticalityRows().filter((r) => r.demand === 'M9-D709');
  assert.deepEqual(rows.map((r) => r.code).sort(), [...e.KPI_CODES].sort());
  for (const r of rows) {
    assert.equal(r.criticality, 'CRITICAL');
    assert.equal(getFormulaCatalog().get(r.formulaId).version, 1, `${r.code}: fórmula v1 entregue`);
    assert.ok(registry.getSourceSpec(r.code), `${r.code}: registerSourceSpec`);
    assert.ok(detailOf(registry.getSourceSpec(r.code)).columns.length > 0 && detailOf(registry.getSourceSpec(r.code)).link, `${r.code}: registerDrilldownDetail`);
  }
  const t = env.cX;
  await e.materialize(t);
  const [defs] = await env.admin.query(
    `SELECT d.metric_code, d.criticality, d.drilldown_enabled, d.owner_role, v.version, v.unit, v.value_nature, v.refresh_policy, v.dimensions FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.company_id = :c AND d.metric_code IN (:codes) ORDER BY d.metric_code`, { replacements: { c: t.companyId, codes: e.KPI_CODES } });
  assert.equal(defs.length, 4);
  for (const d of defs) assert.deepEqual([d.version, d.criticality, d.drilldown_enabled, d.unit, d.value_nature], [1, 'CRITICAL', true, 'COUNT', 'ACTUAL'], d.metric_code);
  assert.deepEqual(defs.find((d) => d.metric_code === 'fin.approvals_pending').dimensions, ['empresa', 'tipo de aprovação', 'solicitante', 'alçada']);
  await e.bi.inTx(t, {}, async (tx) => { // a semente roda em transação revertida: a definição global não fica no banco
    await tx.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx, { rows, now: new Date(Date.now() - 10 * 86400000) });
    assert.deepEqual(out.pending, [], JSON.stringify(out.pending));
    assert.deepEqual([...out.published].sort(), [...e.KPI_CODES].sort(), 'a semente publica a v1 das 4 métricas');
  });
});
