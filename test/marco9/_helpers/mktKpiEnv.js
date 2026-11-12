'use strict';

// Apoio dos testes dos KPIs de Marketing no BI (M9-D670, M9-D671): duas empresas NOVAS no grupo do seed (contagens independentes do que outros testes gravaram),
// relógio fixo em 28/10/2026 12:00 de São Paulo, fontes por superusuário (m9d627Sources: sem FK, só o que o teste precisa), refresh dos read models pelo REBUILD
// (o mesmo caminho do recálculo por evento, partindo das fontes), cálculo dos snapshots e leitura como a API lê. Banco descartável (127.0.0.1). Tudo o que o
// teste grava é apagado em `teardown`.
const bi = require('./biObrasJuridicoEnv');
const sup = require('../../analytics.m9d603.support');
const src = require('./m9d627Sources');
const { sequelize } = require('../../testHelpers');
const registry = require('../../../src/features/analytics/metrics');
const kpisApi = require('../../../src/features/analytics/metrics/kpis');
const clock = require('../../../src/features/analytics/metrics/clock');
const readModels = require('../../../src/features/analytics/read-models');
const { removerDefinicoes } = require('./analyticsResiduo');
require('../../../src/features/analytics');

const MODELS = ['rm_mkt_campaigns', 'rm_mkt_campaign_month', 'rm_mkt_delivery', 'rm_mkt_optout_month', 'rm_mkt_frequency', 'rm_mkt_automation'];
const CODES = ['mkt.campaigns', 'mkt.cost', 'mkt.leads', 'mkt.attribution', 'mkt.deliverability', 'mkt.opt_out', 'mkt.frequency', 'mkt.automations_blocked_failed'];
const { NOW, AS_OF } = bi;
const at = (day, time = '15:00:00') => `2026-${day}T${time}Z`; // 15:00Z = 12:00 em São Paulo

async function newCompany(env, label) {
  const id = bi.uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 D670 ${label} ${id.slice(0, 6)}` } });
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
  const ids = [env.cX.companyId, env.cY.companyId, env.tenantA.companyId, env.tenantB.companyId];
  const own = [env.cX.companyId, env.cY.companyId];
  // o cálculo publica nas empresas novas o catálogo inteiro, não só os oito de Marketing: sem isto, ao apagar a empresa ficavam as outras definições
  // (com versões, snapshots e aceites PENDING) apontando para empresa que não existe mais
  const [doTeste] = await env.admin.query('SELECT id FROM analytics.metric_definitions WHERE company_id IN (:own)', { replacements: { own } });
  await removerDefinicoes(env.admin, doTeste.map((d) => d.id));
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...env.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids) AND metric_id IN (SELECT id FROM analytics.metric_definitions WHERE metric_code IN (:codes))', { replacements: { ids, codes: CODES }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids) AND metric_code IN (:codes))', { replacements: { ids, codes: CODES }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids) AND metric_code IN (:codes)', { replacements: { ids, codes: CODES }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids) AND metric_code IN (:codes)', { replacements: { ids, codes: CODES }, transaction });
    for (const model of MODELS) await env.admin.query(`DELETE FROM analytics.${model} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) {
      await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    }
    await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id IN (:ids) AND (key LIKE 'analytics.owner.mkt.%' OR key LIKE 'analytics.qualidade.%' OR key LIKE 'analytics.frequencia.%' OR key LIKE 'marketing.%')", { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.companies WHERE id IN (:own)', { replacements: { own }, transaction });
  });
  await env.admin.close();
  await sequelize.close();
}

/**
 * Recalcula os seis read models da empresa a partir das fontes (rebuild, M9-D608). `viaEvent` lista os que o rebuild recusaria por qualidade de dado (a mensagem
 * sem destinatário reprova a completude de person_id): o estado deles entra pelo evento do dia-base, como em produção.
 */
async function refreshAll(env, t, { viaEvent = [] } = {}) {
  const ctx = { groupId: t.groupId, actorUserId: t.userId, permissions: ['analytics:rebuild'], reason: 'QA-M9: carga dos read models de Marketing' };
  for (const model of MODELS.filter((m) => !viaEvent.includes(m))) {
    try {
      await readModels.rebuildReadModel(ctx, { model, companyId: t.companyId });
    } catch (err) {
      throw Object.assign(err, { message: `${model}: ${err.message} ${JSON.stringify(err.details || {}).slice(0, 1500)}` });
    }
  }
  if (viaEvent.length) await bi.apply(t, bi.makeEvent(t, 'crm.message.status_changed', { id: bi.uuid(), channel: 'WHATSAPP', status: 'DELIVERED', day: AS_OF }));
}

/** Calcula e grava os snapshots dos oito KPIs da empresa. */
const kpis = (t, asOf = AS_OF) => sup.inTx(t, { commit: true }, (tx) => kpisApi.materializeMarketingKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx));

const ctxOf = (t, permissions = ['analytics:read']) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions });

/** Lê o KPI como a API lê: pelo snapshot gravado da data-base (dimensão opcional). */
const readKpi = (t, metricCode, { asOfDate = AS_OF, dimensionKey = '' } = {}) => sup.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t),
  { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx));

async function dimension(t, metricCode, dimensionKey, asOfDate = AS_OF) {
  try { return (await readKpi(t, metricCode, { asOfDate, dimensionKey })).value; } catch (err) { if (err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE') return null; throw err; }
}

module.exports = { ...bi, src, MODELS, CODES, newCompany, setup, teardown, refreshAll, kpis, readKpi, dimension, ctxOf, at, registry, NOW, AS_OF };
