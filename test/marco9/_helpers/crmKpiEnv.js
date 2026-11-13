'use strict';

// Apoio dos testes dos KPIs do funil comercial (M9-D630, M9-D631): reaproveita o ambiente dos read models de Comercial (duas empresas NOVAS no grupo do
// seed, relógio fixo em 28/10/2026 12:00 de São Paulo, fábricas das fontes do CRM) e acrescenta o cálculo dos KPIs, a leitura como a API lê e a limpeza
// dos registros do BI. Banco descartável (127.0.0.1).
const bi = require('./biEnv');
const registry = require('../../../src/features/analytics/metrics');
const { materializeCrmKpis } = require('../../../src/features/analytics/metrics/kpis');

const { src, NOW, TODAY } = bi;
const CODES = ['crm.leads_by_origin', 'crm.first_response_time', 'crm.opportunities_by_stage', 'crm.conversion_rate', 'crm.loss_reasons', 'crm.portfolio_without_next_action'];

async function setup() {
  registry.clock.setClock(() => NOW);
  return bi.setup();
}

async function teardown(env) {
  registry.clock.resetClock();
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query('DELETE FROM core.tasks WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.data_quality_checks WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
  });
  await bi.teardown(env);
}

const created = (t, id) => bi.makeEvent(t, 'crm.opportunity.created', { id });

/** Aplica o evento de criação de uma oportunidade (recalcula os quatro read models do funil da empresa para o agregado dela). */
const refresh = (t, id) => bi.apply(t, created(t, id));

/** Recalcula os read models do funil para cada oportunidade (criação e, se encerrada, o evento de ganho ou perda), na ordem dada. */
async function refreshAll(t, ids, closed = {}) {
  for (const id of ids) {
    await refresh(t, id);
    if (closed[id]) await bi.apply(t, bi.makeEvent(t, `crm.opportunity.${closed[id]}`, { id }));
  }
}

/** Calcula e grava os snapshots dos KPIs do funil da empresa na data-base. */
const kpis = (t, asOf = TODAY) => bi.inTx(t, { commit: true }, (tx) => materializeCrmKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx));

const ctxOf = (t, permissions = ['analytics:read']) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions });

/** Lê o KPI como a API lê: pelo snapshot gravado da data-base (dimensão opcional). */
const readKpi = (t, metricCode, { asOfDate = TODAY, dimensionKey = '' } = {}) => bi.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t),
  { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx));

/** Valor (texto) de uma dimensão do KPI ou null se não foi gravada. */
async function dimension(t, metricCode, dimensionKey, asOfDate = TODAY) {
  try { return (await readKpi(t, metricCode, { asOfDate, dimensionKey })).value; } catch (err) { if (err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE') return null; throw err; }
}

/** Cenário padrão: abre uma oportunidade com atalhos de fuso (hora de Brasília = UTC-3). */
const at = (day, hh = 12, mm = 0) => new Date(Date.UTC(2026, 9, day, hh + 3, mm)).toISOString();

/** Oportunidade completa para o funil: estágio, fechamento, motivo, próxima ação com data e última edição (a fábrica de biSources não cobre next_action_due_at). */
const opp = (env, t, c = {}) => src.insert(env, 'crm.opportunities', t, {
  person_id: src.uuid(), owner_user_id: 'owner' in c ? c.owner : null, stage: 'stage' in c ? c.stage : 'NEW', lead_source: c.source || null, closed_at: c.closedAt || null, lost_reason: c.lostReason || null,
  next_action: c.nextAction || null, next_action_due_at: c.nextActionDueAt || null, created_at: c.created || at(1), updated_at: c.updated || c.created || at(1),
});

/** Tarefa de CRM (core.tasks) ligada à oportunidade. */
const task = (env, t, c) => src.insert(env, 'core.tasks', t, {
  title: 'Retornar ao cliente', status: c.status || 'OPEN', related_entity_type: 'crm.opportunities', related_entity_id: c.opportunity, due_at: c.dueAt || null,
  created_at: at(1), updated_at: at(1),
});

/**
 * Exemplo numérico da M9-D631 em agosto de 2026 (mês sem outro dado): 6 ganhas e 14 perdidas (preço 6, desistência do cliente 5, sem motivo 3) e
 * uma desistência (WITHDRAWN, que não conta). Devolve { ids, closed, brokers } para `refreshAll`.
 */
async function augustOutcomes(env, t) {
  const brokers = [src.uuid(), src.uuid()];
  const ids = [];
  const closed = {};
  const add = async (stage, i, reason) => {
    const id = await opp(env, t, { owner: brokers[i % 2], stage, created: '2026-07-20T15:00:00Z', closedAt: new Date(Date.UTC(2026, 7, 3 + i, 15)).toISOString(), lostReason: reason });
    ids.push(id);
    closed[id] = stage === 'WON' ? 'won' : 'lost';
  };
  for (let i = 0; i < 6; i += 1) await add('WON', i);
  for (let i = 0; i < 14; i += 1) await add('LOST', i, i < 6 ? 'PRICE' : i < 11 ? 'CLIENT_GAVE_UP' : null);
  await add('WITHDRAWN', 20);
  return { ids, closed, brokers };
}

module.exports = { ...bi, opp, task, augustOutcomes, setup, teardown, refresh, refreshAll, kpis, readKpi, dimension, ctxOf, at, created, CODES, src, registry };
