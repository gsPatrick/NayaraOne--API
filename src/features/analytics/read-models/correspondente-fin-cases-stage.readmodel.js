'use strict';

/**
 * M9-D619 — read model rm_fin_cases_stage (schema analytics): a contagem de casos de financiamento por estágio (o status do caso) e a soma dos dias que
 * os casos estão no estágio atual (para o tempo médio da M9-D661). Dias = dias de calendário de São Paulo entre a entrada no estágio (último registro
 * aplicado do histórico do provider com esse status; sem histórico, a última atualização do caso) e a data-base. O agregado é a empresa inteira: o caso
 * que muda de estágio mexe em duas linhas. Só estágios e contagens; solicitante, imóvel e documentos não entram. Depende do relógio: a agenda recalcula.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { STAGE_EVENTS } = require('./juridico.events');
const { companyAggregateKey, companyKeys } = require('./companyAggregate.keys');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

async function recompute({ companyId, asOfDate, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT fc.status AS stage, (count(*))::int AS count,
            COALESCE(SUM(GREATEST(0, CAST(:asOf AS date) - (COALESCE(
              (SELECT max(h.occurred_at) FROM correspondent.provider_status_history h
                WHERE h.company_id = :companyId AND h.financing_case_id = fc.id AND h.applied AND h.normalized_status = fc.status), fc.updated_at) AT TIME ZONE :tz)::date)), 0)::int AS days_in_stage_sum
       FROM correspondent.financing_cases fc WHERE fc.company_id = :companyId GROUP BY fc.status ORDER BY 1`,
    { replacements: { companyId, asOf: asOfDate, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return { rows: rows.map(({ stage, ...fields }) => ({ key: { stage }, fields })) };
}

const def = registerReadModel({
  name: 'rm_fin_cases_stage',
  version: 1,
  keyColumns: ['stage'],
  aggregateColumns: [],
  eventTypes: [...STAGE_EVENTS],
  aggregateKey: companyAggregateKey,
  recompute,
  scheduled: { keys: companyKeys },
  rebuild: { keys: companyKeys },
});

module.exports = { def, recompute };
