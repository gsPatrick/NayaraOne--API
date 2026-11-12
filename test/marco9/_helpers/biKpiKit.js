'use strict';

// Fábrica do apoio dos testes de KPIs do BI que leem read models (M9-D672, M9-D641): duas empresas NOVAS no grupo do seed (contagens independentes do que outros
// testes gravaram), relógio fixo em 28/10/2026 12:00 de São Paulo, fontes por superusuário (biObrasJuridicoEnv), reconstrução dos read models a partir das fontes,
// cálculo dos snapshots e leitura como a API lê. Banco descartável (127.0.0.1). Tudo o que o teste grava é apagado em `teardown`.
const bi = require('./biObrasJuridicoEnv');
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const registry = require('../../../src/features/analytics/metrics');
const clock = require('../../../src/features/analytics/metrics/clock');
require('../../../src/features/analytics');

const { NOW, AS_OF } = bi;
/** createKit({ models, label, materialize: (t, asOf, tx) => ({...}) }) devolve o apoio do teste. */
function createKit({ models, label, materialize }) {
  async function newCompany(env, name) {
    const id = bi.uuid();
    await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 ${label} ${name} ${id.slice(0, 6)}` } });
    // toda empresa nova entra na limpeza do `teardown`, inclusive a criada dentro de um teste (ex.: a "Z" do m9d640.carteira, que ficava no banco com o catálogo
    // publicado e sem aceite e reprovava a etapa 14 da esteira no m9d708.scripts)
    (env.novasEmpresas = env.novasEmpresas || []).push(id);
    return { groupId: env.tenantA.groupId, companyId: id, userId: env.tenantA.userId };
  }

  async function setup() {
    const env = await bi.setup(models);
    env.cX = await newCompany(env, 'X');
    env.cY = await newCompany(env, 'Y');
    for (const t of [env.cX, env.cY]) await bi.setSetting(env, t, 'analytics.marketing_atendimento.janela_reconferencia_dias', 90); // a passada da agenda reconfere todo o cenário
    return env;
  }

  async function teardown(env) {
    clock.resetClock();
    const ids = [...new Set([env.cX.companyId, env.cY.companyId, ...(env.novasEmpresas || [])])];
    await env.admin.transaction(async (transaction) => {
      await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
      for (const { table, id } of [...env.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
      await env.admin.query('DELETE FROM analytics.metric_snapshot_confirmations WHERE company_id IN (:ids)', { replacements: { ids }, transaction }); // DI-BI-2
      await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
      await env.admin.query('DELETE FROM analytics.metric_acceptance WHERE company_id IN (:ids)', { replacements: { ids }, transaction }); // DI-BI-3: versão nova nasce com aceite PENDING
      await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
      await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
      await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
      for (const model of models) await env.admin.query(`DELETE FROM analytics.${model} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
      for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) {
        await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
      }
      await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
      await env.admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
    });
    await env.admin.close();
    await sequelize.close();
  }

  /** Recalcula os read models da empresa a partir das fontes pela passada da agenda (M9-D607), sem as travas de qualidade do rebuild (M9-D608), que o cenário pode violar de propósito. */
  const rebuild = (t) => bi.runSchedule(t, NOW);

  const kpis = (t, asOf = AS_OF) => sup.inTx(t, { commit: true }, (tx) => materialize(t, asOf, tx));
  const ctxOf = (t, permissions = ['analytics:read']) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions });
  const readKpi = (t, metricCode, { asOfDate = AS_OF, dimensionKey = '' } = {}) => sup.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t), { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx));
  async function dimension(t, metricCode, dimensionKey, asOfDate = AS_OF) {
    try { return (await readKpi(t, metricCode, { asOfDate, dimensionKey })).value; } catch (err) { if (err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE') return null; throw err; }
  }

  return { ...bi, models, newCompany, setup, teardown, rebuild, kpis, readKpi, dimension, ctxOf, registry, NOW, AS_OF };
}

module.exports = { createKit };
