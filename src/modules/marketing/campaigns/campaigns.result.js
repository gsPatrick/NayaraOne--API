'use strict';

const { run } = require('./campaigns.repository');
const { EVENT_BY_METRIC } = require('./campaigns.constants');

/**
 * Resultado mensurável (MKT-009). result_value = contagem de attribution_events válidos da campanha, do tipo da métrica, ocorridos
 * entre starts_at e ends_at (LEADS = LEAD_CREATED, VISITS = VISIT, PROPOSALS = PROPOSAL, SALES = SALE; contagem de eventos, não
 * valor em reais). attainment = result_value / target_value como fração de 4 casas (0,8500); a coluna não existe, o valor é derivado.
 */
async function countResult(campaign, tenant, transaction) {
  const eventType = EVENT_BY_METRIC[campaign.objective_metric];
  if (!eventType) return 0;
  const [row] = await run(
    `SELECT count(*)::int AS n FROM marketing.attribution_events
      WHERE company_id = :companyId AND campaign_id = :id AND valid = true AND deleted_at IS NULL AND event_type = :eventType
        AND occurred_at >= :startsAt AND occurred_at <= :endsAt`,
    { companyId: tenant.companyId, id: campaign.id, eventType, startsAt: campaign.starts_at, endsAt: campaign.ends_at }, transaction
  );
  return row.n;
}

/** Fração com 4 casas (aritmética em centésimos inteiros, sem erro de ponto flutuante); null sem resultado ou sem meta. */
function computeAttainment(resultValue, targetValue) {
  if (resultValue === null || resultValue === undefined || !(Number(targetValue) > 0)) return null;
  return Math.round((Math.round(Number(resultValue) * 100) * 10000) / Math.round(Number(targetValue) * 100)) / 10000;
}

/** 0,8500 -> "85,00%". */
function formatAttainment(attainment) {
  if (attainment === null) return null;
  return `${(Math.round(attainment * 10000) / 100).toFixed(2).replace('.', ',')}%`;
}

/** Custo por resultado = custo real / resultado (2 casas); null enquanto não há resultado (não divide por zero). */
function costPerResult(costActual, resultValue) {
  if (resultValue === null || resultValue === undefined || !(Number(resultValue) > 0)) return null;
  return Math.round((Number(costActual) / Number(resultValue)) * 100) / 100;
}

module.exports = { countResult, computeAttainment, formatAttainment, costPerResult };
