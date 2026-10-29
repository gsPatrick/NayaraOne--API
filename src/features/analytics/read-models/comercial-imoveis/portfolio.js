'use strict';

/**
 * M9-D616 — rm_property_portfolio: imóveis ativos (não excluídos nem inativos na publicação) por situação (availability_status) e, para
 * os disponíveis, por faixa de dias sem venda (dias desde a publicação, ou desde o cadastro se nunca publicado), com os limites em
 * analytics.imoveis.faixas_sem_venda_dias. As faixas dependem do dia: a agenda recalcula. O agregado é a empresa inteira (poucas linhas:
 * situações x faixas), então qualquer mudança de imóvel recalcula todas.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params } = require('./support');

const NAME = 'rm_property_portfolio';
const EVENTS = ['property.created', 'property.updated', 'property.published', 'property.sold', 'property.rented', 'property.merged', 'property.offer.created'];
const NOT_APPLICABLE = 'NAO_SE_APLICA';

/** Rótulos das faixas: [30,60,90,180] -> ATE_30, 31_A_60, 61_A_90, 91_A_180, ACIMA_180. */
function bandLabels(bands) {
  return [...bands.map((b, i) => (i === 0 ? `ATE_${b}` : `${bands[i - 1] + 1}_A_${b}`)), `ACIMA_${bands[bands.length - 1]}`];
}

function bucketCase(bands) {
  const labels = bandLabels(bands);
  const days = `(CAST(:today AS date) - ${sqlDay('COALESCE(p.published_at, p.created_at)')})`;
  const whens = bands.map((b, i) => `WHEN ${days} <= ${Number(b)} THEN '${labels[i]}'`).join(' ');
  return `CASE WHEN p.availability_status <> 'AVAILABLE' THEN '${NOT_APPLICABLE}' ${whens} ELSE '${labels[labels.length - 1]}' END`;
}

const slice = ({ params: p }) => `
  SELECT p.availability_status AS status, ${bucketCase(p.bands)} AS no_sale_days_bucket, COUNT(*)::int AS active_count
    FROM real_estate.properties p
   WHERE p.company_id = :companyId AND p.deleted_at IS NULL AND COALESCE(p.publication_status, '') <> 'INACTIVE'
   GROUP BY 1, 2`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['status', 'no_sale_days_bucket'], aggregateColumns: [], eventTypes: EVENTS, keyOf: () => ({}), params, slice, schedule: { kind: 'keys' },
});
module.exports.bandLabels = bandLabels;
module.exports.NOT_APPLICABLE = NOT_APPLICABLE;
