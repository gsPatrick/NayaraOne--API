'use strict';

/**
 * M9-D618 — read model rm_project_measurements (schema analytics): uma linha por obra com o valor medido, o aprovado, o pendente de aprovação
 * e a data da medição pendente mais antiga. Medido = medições enviadas em diante (SUBMITTED, REVIEWED, APPROVED, PAYABLE; rascunho, rejeitada e
 * substituída por revisão não contam); aprovado = APPROVED e PAYABLE; pendente = SUBMITTED e REVIEWED (medido − aprovado). Valor nulo conta 0.
 * A data pendente é a do envio (data de calendário de São Paulo); a idade em dias é calculada pelo KPI com a data-base.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { MEASUREMENT_EVENTS } = require('./obra.events');
const { projectAggregateKey } = require('./obra.resolve');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

const MEASURED = "('SUBMITTED', 'REVIEWED', 'APPROVED', 'PAYABLE')";
const APPROVED = "('APPROVED', 'PAYABLE')";
const PENDING = "('SUBMITTED', 'REVIEWED')";

async function recompute({ companyId, key, transaction }) {
  const [[row]] = await sequelize.query(
    `SELECT COALESCE(SUM(m.total_amount) FILTER (WHERE m.status IN ${MEASURED}), 0)::text AS measured_value,
            COALESCE(SUM(m.total_amount) FILTER (WHERE m.status IN ${APPROVED}), 0)::text AS approved_value,
            COALESCE(SUM(m.total_amount) FILTER (WHERE m.status IN ${PENDING}), 0)::text AS pending_value,
            to_char(MIN((COALESCE(m.submitted_at, m.created_at) AT TIME ZONE :tz)::date) FILTER (WHERE m.status IN ${PENDING}), 'YYYY-MM-DD') AS oldest_pending_since
       FROM construction.stage_measurements m JOIN construction.project_stages s ON s.id = m.project_stage_id
      WHERE m.company_id = :companyId AND s.company_id = :companyId AND s.project_id = :projectId`,
    { replacements: { companyId, projectId: key.project_id, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return { fields: row };
}

/** Obras que têm medição (a obra sem medição não tem linha: o KPI responde ANALYTICS_READ_MODEL_EMPTY em vez de um zero inventado). */
async function rebuildKeys({ companyId, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT s.project_id::text AS project_id FROM construction.stage_measurements m JOIN construction.project_stages s ON s.id = m.project_stage_id
      WHERE m.company_id = :companyId AND s.company_id = :companyId ORDER BY 1`,
    { replacements: { companyId }, transaction }
  );
  return rows;
}

const def = registerReadModel({
  name: 'rm_project_measurements',
  version: 1,
  keyColumns: ['project_id'],
  eventTypes: [...MEASUREMENT_EVENTS],
  aggregateKey: projectAggregateKey,
  recompute,
  rebuild: { keys: rebuildKeys },
});

module.exports = { def, recompute };
