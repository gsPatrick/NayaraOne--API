'use strict';

/**
 * M9-D618 — read model rm_project_delays (schema analytics): uma linha por obra com as etapas atrasadas, o maior atraso em dias e os
 * componentes da média (soma dos dias, etapas sem data prevista). Etapa atrasada (M9-D651) = fim previsto (data de calendário de São Paulo) antes
 * da data-base e progresso medido abaixo de 100% e etapa não concluída; dias de atraso = diferença em dias de calendário entre a data-base e o
 * fim previsto. Etapa sem fim previsto não é atrasada: entra em `stages_without_date` (o KPI fica INCOMPLETE). Depende do relógio: a agenda
 * recalcula todo dia.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { DELAY_EVENTS } = require('./obra.events');
const { projectAggregateKey, activeProjectKeys, allProjectKeys } = require('./obra.resolve');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

async function recompute({ companyId, key, asOfDate, transaction }) {
  const [[row]] = await sequelize.query(
    `WITH s AS (
       SELECT (ends_at AT TIME ZONE :tz)::date AS due, status, COALESCE(measured_pct, 0) AS measured
         FROM construction.project_stages WHERE company_id = :companyId AND project_id = :projectId AND deleted_at IS NULL),
     late AS (SELECT (CAST(:asOf AS date) - due) AS days FROM s WHERE due IS NOT NULL AND due < CAST(:asOf AS date) AND status <> 'DONE' AND measured < 100)
     SELECT (SELECT count(*) FROM late)::int AS delayed_stages, COALESCE((SELECT max(days) FROM late), 0)::int AS max_delay_days,
            COALESCE((SELECT sum(days) FROM late), 0)::int AS delay_days_sum,
            (SELECT count(*) FROM s WHERE due IS NULL AND status <> 'DONE')::int AS stages_without_date`,
    { replacements: { companyId, projectId: key.project_id, asOf: asOfDate, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return { fields: row };
}

const def = registerReadModel({
  name: 'rm_project_delays',
  version: 1,
  keyColumns: ['project_id'],
  eventTypes: [...DELAY_EVENTS],
  aggregateKey: projectAggregateKey,
  recompute,
  scheduled: { keys: activeProjectKeys },
  rebuild: { keys: allProjectKeys },
});

module.exports = { def, recompute };
