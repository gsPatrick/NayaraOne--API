'use strict';

/**
 * M9-D616 / M9-D632 — rm_property_portfolio: imóveis ativos (não excluídos nem inativos na publicação) por situação (availability_status; vazio
 * vira SEM_STATUS) e, para os disponíveis, por faixa de dias sem venda (dias desde a publicação, ou desde o cadastro se ainda não publicado), com
 * os limites em analytics.imoveis.faixas_sem_venda_dias. Imóvel PUBLICADO sem data de publicação não tem data de entrada no mercado: cai na faixa
 * SEM_DATA (fora das faixas; o KPI sai DEGRADED). Para o KPI do BI (M9-D632) cada linha traz também quantos têm oferta de venda ativa, quantos têm
 * só oferta de locação ativa, quantos são publicados com oferta de venda (base do "sem venda por período") e a contagem por tipo. As faixas dependem
 * do dia: a agenda recalcula. O agregado é a empresa inteira (poucas linhas: situações x faixas), então qualquer mudança de imóvel recalcula todas.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params } = require('./support');

const NAME = 'rm_property_portfolio';
const EVENTS = ['property.created', 'property.updated', 'property.published', 'property.sold', 'property.rented', 'property.merged', 'property.offer.created'];
const NOT_APPLICABLE = 'NAO_SE_APLICA';
const NO_DATE = 'SEM_DATA';
const NO_STATUS = 'SEM_STATUS';

/** Rótulos das faixas: [30,60,90,180] -> ATE_30, 31_A_60, 61_A_90, 91_A_180, ACIMA_180. */
function bandLabels(bands) {
  return [...bands.map((b, i) => (i === 0 ? `ATE_${b}` : `${bands[i - 1] + 1}_A_${b}`)), `ACIMA_${bands[bands.length - 1]}`];
}

function bucketCase(bands) {
  const labels = bandLabels(bands);
  const days = `(CAST(:today AS date) - ${sqlDay('COALESCE(p.published_at, p.created_at)')})`;
  const whens = bands.map((b, i) => `WHEN ${days} <= ${Number(b)} THEN '${labels[i]}'`).join(' ');
  return `CASE WHEN COALESCE(NULLIF(btrim(p.availability_status), ''), '${NO_STATUS}') <> 'AVAILABLE' THEN '${NOT_APPLICABLE}'
               WHEN p.published_at IS NULL AND p.publication_status = 'PUBLISHED' THEN '${NO_DATE}' ${whens} ELSE '${labels[labels.length - 1]}' END`;
}

const offerExists = (types) => `EXISTS (SELECT 1 FROM real_estate.property_offers o WHERE o.property_id = p.id AND o.company_id = p.company_id
  AND o.deleted_at IS NULL AND o.status = 'ACTIVE' AND o.offer_type IN (${types.map((t) => `'${t}'`).join(', ')}))`;

const slice = ({ params: p }) => `
  WITH q AS (
    SELECT COALESCE(NULLIF(btrim(p.availability_status), ''), '${NO_STATUS}') AS status, ${bucketCase(p.bands)} AS bucket,
           ${offerExists(['SALE'])} AS has_sale, ${offerExists(['RENT', 'SEASONAL'])} AS has_rent, p.publication_status = 'PUBLISHED' AS published,
           COALESCE(NULLIF(p.property_type, ''), 'SEM_TIPO') AS t
      FROM real_estate.properties p
     WHERE p.company_id = :companyId AND p.deleted_at IS NULL AND COALESCE(p.publication_status, '') <> 'INACTIVE')
  SELECT status, bucket AS no_sale_days_bucket, COUNT(*)::int AS active_count, COUNT(*) FILTER (WHERE has_sale)::int AS sale_count,
         COUNT(*) FILTER (WHERE has_rent AND NOT has_sale)::int AS rent_count, COUNT(*) FILTER (WHERE has_sale AND published)::int AS sale_published_count,
         COALESCE((SELECT jsonb_object_agg(x.t, x.n) FROM (SELECT t, COUNT(*) AS n FROM q q2 WHERE q2.status = q.status AND q2.bucket = q.bucket GROUP BY 1) x), '{}'::jsonb) AS by_type
    FROM q GROUP BY 1, 2`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['status', 'no_sale_days_bucket'], aggregateColumns: [], eventTypes: EVENTS, keyOf: () => ({}), params, slice, schedule: { kind: 'keys' },
});
module.exports.bandLabels = bandLabels;
module.exports.NOT_APPLICABLE = NOT_APPLICABLE;
module.exports.NO_DATE = NO_DATE;
