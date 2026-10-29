'use strict';

// Apoio dos testes da Saúde Geral (M9-D686): publica todos os indicadores das nove áreas e grava o snapshot de cada um (o caso típico da fórmula, com a base VERDE
// de cada regra de semáforo), para o teste mudar UMA condição e conferir a cor da área. Alertas, parâmetros e versões do painel por superusuário. Banco descartável.
const m685 = require('./m9d685Env');
const kpis = require('../../../src/features/analytics/metrics/kpis');
const { ensureCommercialKpisPublished } = require('../../../src/features/analytics/metrics/kpis/commercial');
const kit = require('./painelKitEnv');
const { AREAS } = require('../../../src/features/analytics/dashboards/health/health.areas');
const { listCriticalityRows } = require('../../../src/features/analytics/metrics/seed/criticality.table');

const OWN = '^(fin|obra|inv|cor|legal|rent|crm|radar|prop|tec|ai|mkt|sup)[.]';
const ok = (value, dims = []) => ({ value, status: 'OK', dimensions: dims.map(([key, v]) => ({ key, value: v })) });
const DIRECTOR = [...m685.READ_ALL, 'marketing:attribution:read', 'crm:feedback:read', 'analytics:manage'];

const env = kit.makeEnv({
  own: OWN,
  publish: async (scope, tx) => {
    for (const fn of ['ensureFinanceKpisPublished', 'ensureCrmKpisPublished', 'ensureObraKpisPublished', 'ensureLegalKpisPublished', 'ensureCorrespondentKpisPublished', 'ensureMarketingKpisPublished',
      'ensureSupportKpisPublished', 'ensureRentalDeadlineKpisPublished', 'ensureRentalPortfolioKpisPublished', 'ensureRentalCareKpisPublished', 'ensureTechKpisPublished', 'ensureCommandEventKpisPublished']) {
      await kpis[fn](scope, tx);
    }
    await ensureCommercialKpisPublished(scope, tx);
    await kpis.obraPerdasKpis.ensurePublished(scope, tx);
    await kpis.estoqueKpis.ensurePublished(scope, tx);
    await kpis.decisionQueueKpis.ensurePublished(scope, tx);
  },
});

const AREA_CODES = [...new Set([...AREAS.flatMap((a) => a.kpis), ...listCriticalityRows().filter((r) => r.criticality === 'CRITICAL' && AREAS.some((a) => a.domains.includes(r.domain))).map((r) => r.code)])];

// 30 min antes do relógio fixo: acima do limite de fin.free_cash (15 min na política da versão) e abaixo do fator de expirado (x4 = 60 min): STALE de verdade, não EXPIRED.
const STALE_AT = '2026-10-28T14:30:00Z';

/** Base VERDE: o valor de cada KPI com regra de semáforo fora dos limites. */
const GREEN = {
  'fin.breathing_need': ok('0.00'), 'legal.deadlines': ok('3', [['proximos_7d_qtd', '3'], ['ate_30d_qtd', '0'], ['vencidos_qtd', '0']]), 'rent.vacancy': ok('6.59'),
  'crm.portfolio_without_next_action': ok('3', [['em_aberto_qtd', '100'], ['sem_acao_pct', '3.00']]), 'mkt.deliverability': ok('98.00'),
  'obra.progress_vs_schedule': ok('60.00', [['planejado_pct', '60.00'], ['desvio_pp', '0.00']]), 'sup.sla_resolution': ok('95.00'), 'tec.availability': ok('99.95'),
  'cor.approval_rate_by_provider': ok('10', [['aprovadas_qtd', '7'], ['rejeitadas_qtd', '3'], ['taxa_pct', '70.00']]),
};

/** Regrava os snapshots: tudo VERDE, com `over` trocando o resultado de alguns códigos; `degraded`, `stale` e `skip` listam códigos. */
async function seedHealth(e, over = {}, { degraded = [], stale = [], skip = [], never = [] } = {}) {
  await env.cleanup(e, e.tenantA);
  await env.publishAll(e.tenantA);
  for (const code of AREA_CODES) {
    if (skip.includes(code)) continue;
    const result = degraded.includes(code) ? undefined : (over[code] || GREEN[code]);
    await env.seedMetric(e.tenantA, code, { degraded: degraded.includes(code), stale: stale.includes(code) && STALE_AT, never: never.includes(code), result });
  }
}

/** Apaga alertas, parâmetros do semáforo e versões do painel `health` que a EMPRESA de teste criou (a definição global não se toca). */
async function clearHealth(e) {
  const t = e.tenantA;
  await e.admin.transaction(async (transaction) => {
    await e.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const c = { c: t.companyId };
    await e.admin.query('DELETE FROM analytics.alert_instances WHERE company_id = :c', { replacements: c, transaction });
    await e.admin.query('DELETE FROM analytics.alert_definitions WHERE company_id = :c', { replacements: c, transaction });
    await e.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND (key LIKE 'analytics.semaforo.%' OR key LIKE 'analytics.saude.%')", { replacements: c, transaction });
    await e.admin.query("DELETE FROM analytics.dashboard_widgets WHERE dashboard_id IN (SELECT id FROM analytics.dashboard_definitions WHERE company_id = :c AND dashboard_code = 'health')", { replacements: c, transaction });
    await e.admin.query("DELETE FROM analytics.dashboard_definitions WHERE company_id = :c AND dashboard_code = 'health'", { replacements: c, transaction });
  });
  env.dashboards.clearCache();
}

const openHealth = (e, { perms = DIRECTOR, query = `asOf=${env.AS_OF}` } = {}) => env.openPanel(e, 'health', { perms, query });
const areaOf = (res, key) => res.body.data.areas.find((a) => a.key === key);

module.exports = { ...env, ...{ alertOf: m685.alertOf, clearQueueAndAlerts: m685.clearQueueAndAlerts, setSetting: m685.setSetting, clearSetting: m685.clearSetting, READ_ALL: m685.READ_ALL },
  ok, DIRECTOR, AREA_CODES, GREEN, seedHealth, clearHealth, openHealth, areaOf };
