'use strict';

/**
 * M9-D651 — consultas dos KPIs de atrasos, medições e não conformidades das obras: as linhas dos read models rm_project_delays, rm_project_measurements e
 * rm_project_nonconformities (M9-D618), com a origem do número. `zeroWithoutRows`: sem linha própria mas com obra no read model de avanço, o KPI vale
 * zero (a obra existe e não tem medição nem desvio); `params` lê o parâmetro do administrador que a fórmula usa.
 */
const { MODELS } = require('./models');
const { readMaxWithoutCausePct } = require('../../../read-models/obraOperacaoKpi.settings');

const T = (model) => `analytics.${model}`;
const COMMON = 'source_snapshot_at AS "sourceSnapshotAt", refreshed_at AS "refreshedAt", version';

module.exports = {
  QUERIES: Object.freeze({
    'obra.delays': {
      sql: `SELECT project_id::text AS id, delayed_stages AS "delayedStages", max_delay_days AS "maxDelayDays", delay_days_sum AS "delayDaysSum", stages_without_date AS "stagesWithoutDate", ${COMMON}
              FROM ${T(MODELS.delays)} WHERE company_id = :companyId ORDER BY project_id`,
      fields: ['id', 'delayedStages', 'maxDelayDays', 'delayDaysSum', 'stagesWithoutDate'],
      key: 'projects',
    },
    'obra.measurements': {
      sql: `SELECT project_id::text AS id, measured_value::text AS measured, approved_value::text AS approved, to_char(oldest_pending_since, 'YYYY-MM-DD') AS "oldestPendingSince",
                   approved_without_payment AS "approvedWithoutPayment", ${COMMON}
              FROM ${T(MODELS.measurements)} WHERE company_id = :companyId ORDER BY project_id`,
      fields: ['id', 'measured', 'approved', 'oldestPendingSince', 'approvedWithoutPayment'],
      key: 'projects',
      zeroWithoutRows: true,
    },
    'obra.nonconformities': {
      sql: `SELECT project_id::text AS "projectId", cause, team_id AS team, open, opened_30d AS "opened30d", closed_30d AS "closed30d", close_days_sum AS "closeDaysSum", ${COMMON}
              FROM ${T(MODELS.nonconformities)} WHERE company_id = :companyId ORDER BY project_id, cause, team_id`,
      fields: ['projectId', 'cause', 'team', 'open', 'opened30d', 'closed30d', 'closeDaysSum'],
      key: 'rows',
      zeroWithoutRows: true,
      params: async (scope, transaction) => ({ maxWithoutCausePct: await readMaxWithoutCausePct(scope, transaction) }),
    },
  }),
};
