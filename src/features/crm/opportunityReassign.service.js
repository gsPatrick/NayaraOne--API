'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Troca de responsável em massa (livro do Marco 3 §18: "Trocar responsável em massa — Permissão específica + audit").
 * A rota exige `crm:opportunities:reassign`; aqui: motivo obrigatório, novo responsável precisa ser membro ATIVO da
 * empresa, lote limitado, tudo ou nada (lock de cada linha) e uma auditoria com antes/depois por oportunidade, mais o
 * registro do lote.
 */
const MAX_BATCH = 200;

function validate({ opportunityIds, toUserId, reason }) {
  const ids = Array.isArray(opportunityIds) ? [...new Set(opportunityIds.map(String))] : [];
  if (!ids.length) throw AppError.badRequest('Informe "opportunityIds" com ao menos uma oportunidade.', 'OPPORTUNITY_REASSIGN_VALIDATION');
  if (ids.length > MAX_BATCH) throw AppError.badRequest(`No máximo ${MAX_BATCH} oportunidades por troca em massa.`, 'OPPORTUNITY_REASSIGN_TOO_MANY');
  if (!toUserId) throw AppError.badRequest('Informe "toUserId" (novo responsável).', 'OPPORTUNITY_REASSIGN_VALIDATION');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 5) throw AppError.badRequest('Informe o motivo da troca de responsável (mínimo 5 caracteres).', 'OPPORTUNITY_REASSIGN_REASON_REQUIRED');
  return { ids, why };
}

async function assertActiveMember(userId, companyId, transaction) {
  const rows = await sequelize.query(
    "SELECT 1 AS ok FROM core.user_memberships um JOIN core.users u ON u.id = um.user_id WHERE um.user_id = :userId AND um.company_id = :companyId AND um.status = 'ACTIVE' AND u.status = 'ACTIVE' LIMIT 1",
    { replacements: { userId, companyId }, type: QueryTypes.SELECT, transaction }
  );
  if (!rows.length) throw AppError.unprocessable('O novo responsável precisa ser um usuário ativo desta empresa.', 'OPPORTUNITY_REASSIGN_INVALID_OWNER');
}

async function bulkReassign(payload, actor, transaction) {
  const { ids, why } = validate(payload || {});
  await assertActiveMember(payload.toUserId, actor.companyId, transaction);
  const found = await Opportunity.findAll({ where: { id: ids }, lock: transaction.LOCK.UPDATE, transaction });
  if (found.length !== ids.length) {
    const missing = ids.filter((id) => !found.some((o) => o.id === id));
    throw AppError.notFound('Uma ou mais oportunidades não existem nesta empresa; nenhuma troca foi feita.', 'OPPORTUNITY_NOT_FOUND', { missing });
  }
  const changes = [];
  for (const opportunity of found) {
    if (opportunity.ownerUserId === payload.toUserId) continue;
    const beforeJson = opportunity.toJSON();
    opportunity.ownerUserId = payload.toUserId;
    opportunity.updatedBy = actor.userId || null;
    await opportunity.save({ transaction });
    await registrarAuditoria(
      {
        groupId: opportunity.groupId,
        companyId: opportunity.companyId,
        actorUserId: actor.userId,
        action: 'opportunity.bulk_reassign',
        entityType: 'Opportunity',
        entityId: opportunity.id,
        beforeJson,
        afterJson: opportunity.toJSON(),
        reason: `Troca de responsável em massa: ${why}`,
      },
      transaction
    );
    changes.push({ id: opportunity.id, fromUserId: beforeJson.ownerUserId || null, toUserId: payload.toUserId });
  }
  return { requested: ids.length, changed: changes.length, unchanged: ids.length - changes.length, changes, reason: why };
}

module.exports = { bulkReassign, MAX_BATCH };
