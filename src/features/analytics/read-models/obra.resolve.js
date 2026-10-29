'use strict';

/**
 * M9-D618 — de qual OBRA é o evento (a chave do agregado dos read models de Obras) e quais obras a agenda e o rebuild reconferem.
 * A resolução lê só a linha do registro citado no evento, sob o RLS da empresa. Evento sem obra (lançamento sem obra, contrato sem
 * obra, movimento sem obra) devolve null: não interessa ao read model. Caso de garantia sem obra vinculada vai para a obra "zero"
 * (NIL), que o pós-obra mantém para o KPI acusar DEGRADED (M9-D652: ocorrência sem obra vinculada).
 */
const { sequelize } = require('../../../models');

const NIL_PROJECT = '00000000-0000-0000-0000-000000000000';

const ID_IS_PROJECT = new Set([
  'project.created', 'project.started', 'construction.project.status_changed', 'project.schedule.updated', 'project.delivered',
  'project.warranty_started', 'project.closed', 'project.delay.detected',
]);
const PROJECT_ID_IN_PAYLOAD = new Set(['project.stage.updated', 'project.stage.completed', 'project.daily_log.created', 'project.budget.approved', 'nonconformity.opened', 'nonconformity.closed']);
const BY_STAGE = new Set(['measurement.submitted', 'measurement.approved', 'construction.stage_measurement.decided']);
const BY_LEDGER = new Set(['finance.entry.created', 'finance.entry.settled', 'finance.entry.reversed']);
const BY_CONTRACT = new Set(['contract.activated', 'contract.terminated', 'legal.contract.status_changed']);
const BY_WARRANTY = new Set(['warranty.case.opened', 'warranty.case.closed', 'warranty.case.escalated']);

async function pick(sql, replacements, transaction) {
  const [rows] = await sequelize.query(sql, { replacements, transaction });
  return rows.length ? rows[0].project_id : undefined;
}

const payloadOf = (event) => event.payloadJson || event.payload || {};

/** id da obra do evento, NIL_PROJECT (garantia sem obra) ou null (o evento não é de uma obra). */
async function resolveProjectId(event, transaction) {
  const type = event.eventType;
  const p = payloadOf(event);
  const base = { companyId: event.companyId };
  let id;
  if (ID_IS_PROJECT.has(type)) id = p.id || event.aggregateId;
  else if (PROJECT_ID_IN_PAYLOAD.has(type)) id = p.projectId;
  else if (BY_STAGE.has(type)) id = await pick('SELECT project_id FROM construction.project_stages WHERE company_id = :companyId AND id = :id', { ...base, id: p.projectStageId }, transaction);
  else if (BY_LEDGER.has(type)) id = await pick('SELECT construction_project_id AS project_id FROM finance.financial_entries WHERE company_id = :companyId AND id = :id', { ...base, id: p.id || p.originalEntryId }, transaction);
  else if (BY_CONTRACT.has(type)) id = await pick('SELECT construction_project_id AS project_id FROM legal.contracts WHERE company_id = :companyId AND id = :id', { ...base, id: p.id }, transaction);
  else if (BY_WARRANTY.has(type)) {
    id = await pick('SELECT project_id FROM construction.maintenance_cases WHERE company_id = :companyId AND id = :id', { ...base, id: p.id }, transaction);
    return id === undefined ? null : id || NIL_PROJECT;
  } else if (type === 'inventory.movement.recorded') id = await pick('SELECT project_id FROM inventory.inventory_movements WHERE company_id = :companyId AND id = :id', { ...base, id: p.id }, transaction);
  return id || null;
}

/** aggregateKey dos read models por obra. */
const projectAggregateKey = async (event, { transaction }) => {
  const id = await resolveProjectId(event, transaction);
  return id ? { project_id: id } : null;
};

/** Obras que a agenda reconfere (as que ainda se movem com o tempo). */
async function activeProjectKeys({ companyId, limit, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT id::text AS project_id FROM construction.projects
      WHERE company_id = :companyId AND deleted_at IS NULL AND status NOT IN ('CLOSED', 'CANCELLED') ORDER BY id LIMIT :limit`,
    { replacements: { companyId, limit: limit || 5000 }, transaction }
  );
  return rows;
}

/** TODAS as obras da empresa (rebuild: o estado de cada obra a partir da fonte). */
async function allProjectKeys({ companyId, transaction }) {
  const [rows] = await sequelize.query(
    'SELECT id::text AS project_id FROM construction.projects WHERE company_id = :companyId AND deleted_at IS NULL ORDER BY id',
    { replacements: { companyId }, transaction }
  );
  return rows;
}

/** Fim do dia-base (instante) no calendário de São Paulo: limite superior exclusivo das liquidações e fotografias do dia. */
const dayEndOf = (asOfDate) => new Date(`${asOfDate}T12:00:00-03:00`).getTime() + 12 * 3600 * 1000;
const dayEndIso = (asOfDate) => new Date(dayEndOf(asOfDate)).toISOString();

module.exports = { NIL_PROJECT, resolveProjectId, projectAggregateKey, activeProjectKeys, allProjectKeys, dayEndIso };
