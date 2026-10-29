'use strict';

/**
 * M9-D616 — rm_property_price_changes: por dia (SP), quantas mudanças de preço de oferta e a variação percentual (nova - antiga) / antiga
 * das que tinham preço anterior maior que zero: soma (change_pct_sum, de onde a média do KPI sai) e média (avg_change_pct, coluna do livro).
 * O agregado é o DIA; o evento property.price.changed carrega o instante da mudança.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params } = require('./support');
const { businessDateKey } = require('../../../../utils/businessDate');

const NAME = 'rm_property_price_changes';
const PCT = '((h.new_price - h.old_price) / h.old_price * 100)';

const slice = ({ where }) => `
  SELECT ${sqlDay('h.changed_at')}::text AS day, COUNT(*)::int AS changes,
         COALESCE(ROUND(SUM(${PCT}) FILTER (WHERE h.old_price > 0), 4), 0) AS change_pct_sum,
         COALESCE(ROUND(AVG(${PCT}) FILTER (WHERE h.old_price > 0), 4), 0) AS avg_change_pct
    FROM real_estate.property_price_history h
   WHERE h.company_id = :companyId${where({ day: sqlDay('h.changed_at') })}
   GROUP BY 1`;

const keysSql = () => `SELECT DISTINCT ${sqlDay('changed_at')}::text AS day FROM real_estate.property_price_history WHERE company_id = :companyId`;

module.exports = defineAggregateModel({
  name: NAME, keyColumns: ['day'], eventTypes: ['property.price.changed'], keyOf: (event, { now }) => ({ day: businessDateKey(event.occurredAt || now) }),
  params, slice, keysSql, schedule: { kind: 'recent_days', column: 'day' },
});
