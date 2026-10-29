'use strict';

/**
 * M9-D628 — rm_tech_integrations: por fornecedor, família (as 14 de M9-D201, `integration.providers.domain`), ambiente da connection e janela (`window_minutes`, as que o
 * health grava: 5, 60 e 1440), os 9 valores de saúde de integration.provider_health (M9-D206/D224, decisão C10) lidos da ÚLTIMA janela fechada de cada connection ACTIVE e somados:
 * chamadas (`calls`), erros (`errors`), sucesso (`success_rate`, recalculado das somas, duas casas), latência p95 e p99 (a PIOR entre as connections: percentil não se soma),
 * `rate_limit_count`, `auth_failures`, `retries`, `dlq`, `backlog` e `quota_remaining` (soma; nulo quando nenhuma connection informou cota). `error_limit_pct` = 100 menos o
 * sucesso mínimo do SLO da criticidade do fornecedor (integration.slo.<CRITICIDADE>, Bloco B) e `connections` quantas entraram. Só contagens e códigos: sem segredo, URL, payload ou nome de pessoa.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');
const { INTEGRATION_EVENTS } = require('./events');
const { readSloTargets } = require('../../../integrations/health/sloTargets.readRepository');

const KEY = ['provider', 'family', 'environment', 'window_minutes'];

async function build({ companyId, groupId, transaction }) {
  const slo = await readSloTargets({ companyId, groupId }, transaction);
  const records = await select(
    `WITH last AS (
       SELECT DISTINCT ON (h.connection_id, h.window_minutes) h.* FROM integration.provider_health h
        WHERE h.company_id = :companyId AND h.window_minutes > 0 ORDER BY h.connection_id, h.window_minutes, h.window_start DESC)
     SELECT l.provider_code AS provider, p.domain AS family, c.environment, l.window_minutes, p.criticality,
            COALESCE(sum(l.calls_total), 0)::int AS calls, COALESCE(sum(l.calls_failed), 0)::int AS errors,
            CASE WHEN COALESCE(sum(l.calls_total), 0) = 0 THEN NULL ELSE round(100.0 * sum(l.calls_success) / sum(l.calls_total), 2) END AS success_rate,
            max(l.latency_p95_ms)::int AS latency_p95_ms, max(l.latency_p99_ms)::int AS latency_p99_ms,
            COALESCE(sum(l.rate_limit_count), 0)::int AS rate_limit_count, COALESCE(sum(l.auth_failures), 0)::int AS auth_failures, COALESCE(sum(l.retries_total), 0)::int AS retries,
            COALESCE(sum(l.dlq_count), 0)::int AS dlq, COALESCE(sum(l.backlog_count), 0)::int AS backlog, sum(l.quota_remaining)::int AS quota_remaining, count(*)::int AS connections
       FROM last l JOIN integration.connections c ON c.id = l.connection_id AND c.company_id = l.company_id AND c.status = 'ACTIVE'
       JOIN integration.providers p ON p.code = l.provider_code
      GROUP BY l.provider_code, p.domain, c.environment, l.window_minutes, p.criticality ORDER BY 1, 2, 3, 4`,
    { companyId }, transaction
  );
  return records.map(({ criticality, ...record }) => toRow(KEY)({ ...record, error_limit_pct: slo.errorLimitPct(criticality) }));
}

const def = defineCompanyWideModel({ name: 'rm_tech_integrations', keyColumns: KEY, events: INTEGRATION_EVENTS, build });

module.exports = { def, build };
