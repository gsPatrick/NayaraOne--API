'use strict';

/**
 * M9-D619 — read model rm_legal_values (schema analytics): por tipo de processo e nível de risco, o valor ESTIMADO (processos ativos) e o valor
 * CONFIRMADO (condenação, acordo ou perda já confirmados, de qualquer processo) em colunas separadas que nunca se somam (M9-D610). Mais a contagem de
 * processos ativos sem valor estimado (o KPI conta em `details.withoutValue`). Ativo = como em rm_legal_cases_risk. O agregado é a empresa inteira.
 * Só valores e níveis; partes, teor e advogado não entram.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { CASE_EVENTS } = require('./juridico.events');
const { readFinishedStatuses } = require('./juridico.settings');
const { companyAggregateKey, companyKeys } = require('./companyAggregate.keys');

async function recompute({ companyId, groupId, transaction }) {
  const finished = await readFinishedStatuses({ companyId, groupId }, transaction);
  const [rows] = await sequelize.query(
    `WITH c AS (
       SELECT case_type, COALESCE(NULLIF(upper(risk_level), ''), 'SEM_CLASSIFICACAO') AS risk_level, estimated_amount, confirmed_amount,
              (upper(status) NOT IN (:finished) AND upper(COALESCE(phase, '')) NOT IN (:finished)) AS active
         FROM legal.legal_cases WHERE company_id = :companyId AND deleted_at IS NULL)
     SELECT case_type, risk_level,
            COALESCE(SUM(estimated_amount) FILTER (WHERE active), 0)::text AS estimated_total,
            COALESCE(SUM(confirmed_amount), 0)::text AS confirmed_total,
            (count(*) FILTER (WHERE active AND estimated_amount IS NULL))::int AS cases_without_value
       FROM c GROUP BY 1, 2 HAVING bool_or(active) OR COALESCE(SUM(confirmed_amount), 0) <> 0 ORDER BY 1, 2`,
    { replacements: { companyId, finished }, transaction }
  );
  return { rows: rows.map(({ case_type: type, risk_level: risk, ...fields }) => ({ key: { case_type: type, risk_level: risk }, fields })) };
}

const def = registerReadModel({
  name: 'rm_legal_values',
  version: 1,
  keyColumns: ['case_type', 'risk_level'],
  aggregateColumns: [],
  eventTypes: [...CASE_EVENTS],
  aggregateKey: companyAggregateKey,
  recompute,
  rebuild: { keys: companyKeys },
});

module.exports = { def, recompute };
