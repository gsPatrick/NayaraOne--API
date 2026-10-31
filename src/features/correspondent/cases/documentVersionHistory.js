'use strict';

const { AuditLog, User } = require('../../../models');

// O modelo mapeia o atributo de criação como `created_at` (opção createdAt: 'created_at'): `row.createdAt` vem vazio.
const createdAtOf = (row) => row.get('created_at') || row.get('createdAt') || null;

/**
 * Quando e por quem o item foi validado: o registro de auditoria da validação mais recente; sem ele,
 * a última atualização do item. Nunca inventa data.
 */
async function findRequirementValidation(requirement, transaction) {
  if (requirement.status !== 'VALIDATED') return null;
  const audit = await AuditLog.findOne({
    where: { entityId: requirement.id, groupId: requirement.groupId, companyId: requirement.companyId, action: 'correspondent.case_requirement.validated' },
    order: [['occurred_at', 'DESC']],
    transaction,
  });
  const byId = audit?.userId || requirement.updatedBy || null;
  const user = byId ? await User.findOne({ where: { id: byId }, attributes: ['id', 'name'], transaction }) : null;
  return {
    at: audit?.occurredAt || audit?.get('created_at') || requirement.get('updated_at') || null,
    by: byId,
    byName: user?.name || null,
  };
}

/** Situação de validação por versão: a validação vale para a versão vigente; a substituída não afirma validação. */
function validationOf(version, requirementValidation) {
  if (version.supersededAt) return { status: 'SUBSTITUIDA', at: version.supersededAt };
  if (requirementValidation) return { status: 'VALIDADA', ...requirementValidation };
  return { status: 'PENDENTE' };
}

module.exports = { createdAtOf, findRequirementValidation, validationOf };
