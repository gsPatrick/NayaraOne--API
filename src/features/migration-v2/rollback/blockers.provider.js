'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const providers = require('../control/blockers.providers');
const { accountableOf } = require('../control/blockers.rules');
const raci = require('../raci/raci.service');
const readiness = require('./readiness');
const { BLOCKER, ACTIVITY_ROLLBACK, STATES } = require('./rollback.constants');

/**
 * Blockers da Torre de controle (M9-D901) que esta demanda define: (1) GOV_ROLLBACK_COMPENSATION_REQUIRED, um por tipo de operação externa sem plano de compensação
 * (sai quando o plano é cadastrado); (2) GOV_ROLLBACK_PENDING, um por setor e tipo com compensações pendentes de um rollback de setor (sai quando o último item é resolvido).
 * O dono é quem responde (A) pela atividade ROLLBACK_EXECUTION do RACI (M9-D902). O detalhe só tem contagens, nunca o conteúdo das operações.
 */
async function provide(tenant, scope, transaction) {
  const matrix = await raci.getMatrix(tenant, transaction);
  const owner = accountableOf(matrix.activities.find((activity) => activity.code === ACTIVITY_ROLLBACK));
  const out = [];
  for (const type of await readiness.typesWithoutPlan(tenant, transaction)) {
    out.push({ code: BLOCKER.COMPENSATION_REQUIRED, entity: type.entity || null, ref: `type:${type.code}`, owner, detail: { type: type.code, missing: type.missing } });
  }
  const pending = await sequelize.query(
    `SELECT i.sector, t.code AS "opType", t.entity, count(*)::int AS count, COALESCE(sum(l.amount_cents), 0)::bigint AS "amountCents"
       FROM governance.rollback_items i
       JOIN governance.external_op_log l ON l.company_id = i.company_id AND l.id = i.log_id
       JOIN governance.external_op_types t ON t.company_id = l.company_id AND t.id = l.type_id
      WHERE i.company_id = :companyId AND i.state = :pending GROUP BY i.sector, t.code, t.entity ORDER BY i.sector, t.code`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, pending: STATES.PENDING } }
  );
  for (const row of pending) {
    out.push({ code: BLOCKER.PENDING, entity: row.entity || null, ref: `${row.sector}:${row.opType}`, owner, detail: { sector: row.sector, type: row.opType, count: row.count, amount_cents: Number(row.amountCents) } });
  }
  return out;
}

const unregister = providers.register('migration-rollback-plan', provide);

module.exports = { provide, unregister };
