'use strict';

// Apoio dos testes dos KPIs do Jurídico no BI (M9-D660): duas empresas NOVAS no grupo do seed (contagens independentes
// do que outros testes gravaram), relógio fixo em 28/10/2026 12:00 de São Paulo, fontes por superusuário (biObrasJuridicoEnv), refresh dos sete read
// models, cálculo dos snapshots e leitura como a API lê. Banco descartável (127.0.0.1). Tudo o que o teste grava é apagado em `teardown`.
const bi = require('./biObrasJuridicoEnv');
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const registry = require('../../../src/features/analytics/metrics');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');
const clock = require('../../../src/features/analytics/metrics/clock');
require('../../../src/features/analytics');

const MODELS = ['rm_legal_deadlines', 'rm_legal_cases_risk', 'rm_legal_values', 'rm_legal_missing_docs', 'rm_fin_cases_stage', 'rm_fin_provider_outcome', 'rm_fin_commission'];
const LEGAL = ['legal.deadlines', 'legal.cases_by_risk', 'legal.values', 'legal.missing_documents'];
const COR = ['cor.cases_by_stage', 'cor.approval_rate_by_provider', 'cor.analysis_time', 'cor.commission'];
const { NOW, AS_OF } = bi;

async function newCompany(env, label) {
  const id = bi.uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 D660 ${label} ${id.slice(0, 6)}` } });
  return { groupId: env.tenantA.groupId, companyId: id, userId: env.tenantA.userId };
}

async function setup() {
  const env = await bi.setup(MODELS);
  env.cX = await newCompany(env, 'X');
  env.cY = await newCompany(env, 'Y');
  return env;
}

async function teardown(env) {
  clock.resetClock();
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...env.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    for (const model of MODELS) await env.admin.query(`DELETE FROM analytics.${model} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) {
      await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    }
    await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
  });
  await env.admin.close();
  await sequelize.close();
}

const EVENTS = [
  ['legal.deadline.created', {}], ['legal.case.updated', {}], ['legal.contract_requirement.updated', {}], ['financing.status.changed', {}], ['commission.confirmed', {}],
];

/** Aplica os eventos que atualizam os read models do Jurídico, dos estágios e da comissão; `decided` são os casos aprovados ou rejeitados (mês da decisão). */
async function refreshAll(t, decided = []) {
  for (const [type, payload] of EVENTS) await bi.apply(t, bi.makeEvent(t, type, { id: bi.uuid(), ...payload }));
  for (const id of decided) await bi.apply(t, bi.makeEvent(t, 'financing.approved', { id }));
}

/** Calcula e grava os snapshots dos KPIs da empresa. */
const kpis = (t, asOf = AS_OF) => sup.inTx(t, { commit: true }, async (tx) => ({
  legal: await kpisApi.materializeLegalKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx),
}));

const ctxOf = (t, permissions = ['analytics:read']) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions });

/** Lê o KPI como a API lê: pelo snapshot gravado da data-base (dimensão opcional). */
const readKpi = (t, metricCode, { asOfDate = AS_OF, dimensionKey = '' } = {}) => sup.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t),
  { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx));

async function dimension(t, metricCode, dimensionKey, asOfDate = AS_OF) {
  try { return (await readKpi(t, metricCode, { asOfDate, dimensionKey })).value; } catch (err) { if (err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE') return null; throw err; }
}

/** Resumo de um read model para o teste do KPI mudar o dado depois de calculado. */
const query = async (env, sql, replacements) => (await env.admin.query(sql, { replacements }))[0];

module.exports = { ...bi, MODELS, LEGAL, COR, newCompany, setup, teardown, refreshAll, kpis, readKpi, dimension, ctxOf, query, registry, NOW, AS_OF };
