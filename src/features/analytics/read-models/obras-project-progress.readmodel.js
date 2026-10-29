'use strict';

/**
 * M9-D618 — read model rm_project_progress (schema analytics): uma linha por obra com o avanço planejado (baseline) e o realizado (actual)
 * em %, o término previsto (forecast, PROJECTED) e o término planejado. Só ids e agregados. O worker (M9-D607) chama `recompute` com o ESTADO
 * atual das etapas (nunca delta); a agenda recalcula a previsão, que muda com o dia (o ritmo é por dia decorrido).
 */
const { registerReadModel } = require('./readModel.registry');
const { PROGRESS_EVENTS } = require('./obra.events');
const { projectAggregateKey, activeProjectKeys, allProjectKeys } = require('./obra.resolve');
const { readStageProgress, readProjectDates } = require('./obra.progress.query');
const { forecastFinishDate } = require('./obra.forecast');
const { readForecastMethod } = require('./obra.settings');

async function recompute({ companyId, groupId, key, asOfDate, transaction }) {
  const stages = await readStageProgress(companyId, key.project_id, transaction); // em sequência: uma transação só aceita uma consulta por vez
  const dates = await readProjectDates(companyId, key.project_id, transaction);
  const method = await readForecastMethod({ companyId, groupId }, transaction);
  const d = dates || {};
  return {
    fields: {
      baseline_percent: stages.baseline_percent, actual_percent: stages.actual_percent, stages_total: stages.stages,
      baseline_finish_date: d.planned_end_date || null,
      forecast_finish_date: forecastFinishDate({
        method, asOfDate, startDate: d.start_date, plannedEndDate: d.planned_end_date, actualEndDate: d.actual_end_date, actualPercent: stages.actual_percent,
      }),
    },
  };
}

const def = registerReadModel({
  name: 'rm_project_progress',
  version: 1,
  keyColumns: ['project_id'],
  eventTypes: [...PROGRESS_EVENTS],
  aggregateKey: projectAggregateKey,
  recompute,
  scheduled: { keys: activeProjectKeys },
  rebuild: { keys: allProjectKeys },
});

module.exports = { def, recompute };
