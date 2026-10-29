'use strict';

/**
 * M9-D616 / M9-D632 — rm_property_price_changes: por dia (SP), quantas mudanças de preço de oferta e a variação percentual (nova - antiga) / antiga
 * das que tinham preço anterior maior que zero: soma (change_pct_sum, de onde a média do KPI sai) e média (avg_change_pct, coluna do livro). Para o
 * KPI do BI (M9-D632) o dia traz também quantas mudanças tinham preço anterior (with_prior) e as mudanças por corretor (quem mudou o preço) e por
 * tipo de imóvel. O agregado é o DIA; o evento property.price.changed carrega o instante da mudança.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params } = require('./support');
const { businessDateKey } = require('../../../../utils/businessDate');

const NAME = 'rm_property_price_changes';

const slice = ({ where }) => `
  WITH hx AS (
    SELECT ${sqlDay('h.changed_at')} AS day, h.old_price, h.new_price, COALESCE(h.changed_by::text, CAST(:noBroker AS text)) AS b, COALESCE(NULLIF(p.property_type, ''), 'SEM_TIPO') AS t
      FROM real_estate.property_price_history h
      LEFT JOIN real_estate.property_offers o ON o.id = h.offer_id AND o.company_id = h.company_id
      LEFT JOIN real_estate.properties p ON p.id = o.property_id AND p.company_id = h.company_id
     WHERE h.company_id = :companyId${where({ day: sqlDay('h.changed_at') })}),
  agg AS (
    SELECT day, COUNT(*) AS changes, COUNT(*) FILTER (WHERE old_price > 0) AS with_prior,
           COALESCE(ROUND(SUM((new_price - old_price) / old_price * 100) FILTER (WHERE old_price > 0), 4), 0) AS change_pct_sum,
           COALESCE(ROUND(AVG((new_price - old_price) / old_price * 100) FILTER (WHERE old_price > 0), 4), 0) AS avg_change_pct
      FROM hx GROUP BY 1),
  bb AS (SELECT day, jsonb_object_agg(b, n) AS by_broker FROM (SELECT day, b, COUNT(*) AS n FROM hx GROUP BY 1, 2) x GROUP BY 1),
  bt AS (SELECT day, jsonb_object_agg(t, n) AS by_type FROM (SELECT day, t, COUNT(*) AS n FROM hx GROUP BY 1, 2) x GROUP BY 1)
  SELECT agg.day::text AS day, agg.changes::int AS changes, agg.with_prior::int AS with_prior, agg.change_pct_sum, agg.avg_change_pct,
         COALESCE(bb.by_broker, '{}'::jsonb) AS by_broker, COALESCE(bt.by_type, '{}'::jsonb) AS by_type
    FROM agg LEFT JOIN bb ON bb.day = agg.day LEFT JOIN bt ON bt.day = agg.day`;

const keysSql = () => `SELECT DISTINCT ${sqlDay('changed_at')}::text AS day FROM real_estate.property_price_history WHERE company_id = :companyId`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['day'], eventTypes: ['property.price.changed'], keyOf: (event, { now }) => ({ day: businessDateKey(event.occurredAt || now) }),
  params, slice, keysSql, schedule: { kind: 'recent_days', column: 'day' },
});
