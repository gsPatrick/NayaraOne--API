'use strict';

// Apoio dos testes dos KPIs de Obras do BI (M9-D650, M9-D651): reaproveita o ambiente dos read models de Obras da M9-D618 (empresa A com relógio fixo em
// 28/10/2026 12:00 de São Paulo, fontes gravadas por superusuário, eventos reais aplicados pelo worker) e acrescenta o cálculo dos snapshots dos
// KPIs, a leitura como a API lê e a limpeza do que os KPIs gravam. Banco descartável (127.0.0.1).
const bi = require('./biObrasJuridicoEnv');
const registry = require('../../../src/features/analytics/metrics');
const { materializeObraKpis } = require('../../../src/features/analytics/metrics/kpis');

const MODELS = ['rm_project_progress', 'rm_project_cost', 'rm_project_delays', 'rm_project_measurements', 'rm_project_nonconformities'];
const CODES = ['obra.progress_vs_schedule', 'obra.baseline_actual_forecast', 'obra.projected_margin', 'obra.delays', 'obra.measurements', 'obra.nonconformities'];
const READ = ['analytics:read'];

const setup = () => bi.setup(MODELS);

async function teardown(env) {
  const ids = [env.tenantA.companyId, env.tenantB.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const owned = '(SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids) AND metric_code IN (:codes))';
    const replacements = { ids, codes: CODES };
    await env.admin.query(`DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids) AND metric_id IN ${owned}`, { replacements, transaction });
    await env.admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN ${owned}`, { replacements, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids) AND metric_code IN (:codes)', { replacements, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids) AND metric_code IN (:codes)', { replacements, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.owner.obra.%' OR key = 'analytics.qualidade.max_sem_causa_pct'", { transaction });
  });
  await bi.teardown(env);
}

/** Aplica os eventos reais que atualizam os cinco read models de Obras: obras (progresso, custo, atrasos), medições e não conformidades. */
async function refresh(t, projects) {
  for (const { id, stage } of projects) {
    await bi.apply(t, bi.makeEvent(t, 'project.created', { id }));
    if (stage) await bi.apply(t, bi.makeEvent(t, 'measurement.submitted', { projectStageId: stage }));
    await bi.apply(t, bi.makeEvent(t, 'nonconformity.opened', { projectId: id }));
  }
}

/** Calcula e grava os snapshots dos KPIs de Obras da empresa na data-base (devolve { kpis, written }). */
const kpis = (t, asOf = bi.AS_OF) => bi.inTx(t, { commit: true }, (tx) => materializeObraKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx));

const ctxOf = (t, permissions = READ) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions });

/** Lê o KPI como a API lê: pelo snapshot gravado da data-base (dimensão opcional). */
const readKpi = (t, metricCode, { asOfDate = bi.AS_OF, dimensionKey = '' } = {}) => bi.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t),
  { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx));

/** Todas as dimensões gravadas do KPI na data-base (chave -> valor da última revisão). */
async function dimensionsOf(env, t, metricCode, asOfDate = bi.AS_OF) {
  const [rows] = await env.admin.query(
    `SELECT s.dimension_key, s.value_numeric::text AS value, s.revision_no FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
      WHERE s.company_id = :c AND d.metric_code = :code AND s.as_of_date = :asOf AND s.revision_no = (SELECT max(revision_no) FROM analytics.metric_snapshots x
        WHERE x.metric_id = s.metric_id AND x.dimension_key = s.dimension_key AND x.as_of_date = s.as_of_date AND x.scope_id = s.scope_id) ORDER BY s.dimension_key`,
    { replacements: { c: t.companyId, code: metricCode, asOf: asOfDate } }
  );
  return Object.fromEntries(rows.map((r) => [r.dimension_key, r.value]));
}

const definitionOf = async (env, t, code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: t.companyId, code } }))[0][0];

module.exports = { ...bi, MODELS, CODES, setup, teardown, refresh, kpis, ctxOf, readKpi, dimensionsOf, definitionOf, READ };
