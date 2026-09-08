'use strict';

const { Contract, BillingSchedule, CollectionCase, OwnershipTransferTask, UtilityObligation } = require('../../models');
const { Op } = require('sequelize');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishCloseoutBlocked, publishCloseoutCompleted } = require('./billingEvents.service');

/**
 * checkCloseoutEligibility — verifica se um contrato de locação pode ser encerrado (closeout).
 * Pendências CRÍTICAS que bloqueiam (Caderno M07: "verifica obrigação crítica pendente"):
 *   - cobrança em aberto: qualquer BillingSchedule OPEN/PARTIALLY_PAID, ou CollectionCase não
 *     RESOLVED, do contrato;
 *   - transferência de utilidade não concluída: qualquer OwnershipTransferTask PENDING de
 *     qualquer UtilityObligation do contrato.
 * Retorna a lista de motivos de bloqueio (vazia = sem pendências).
 */
async function checkCloseoutEligibility(contractId, transaction) {
  const reasons = [];

  const openBillingSchedules = await BillingSchedule.findAll({
    where: { contractId, status: { [Op.in]: ['OPEN', 'PARTIALLY_PAID'] } },
    transaction,
  });
  if (openBillingSchedules.length > 0) {
    reasons.push({
      type: 'OPEN_BILLING',
      detail: `${openBillingSchedules.length} competência(s) de cobrança ainda em aberto.`,
      billingScheduleIds: openBillingSchedules.map((b) => b.id),
    });
  }

  const openCollectionCases = await CollectionCase.findAll({
    where: { contractId, status: { [Op.ne]: 'RESOLVED' } },
    transaction,
  });
  if (openCollectionCases.length > 0) {
    reasons.push({
      type: 'OPEN_COLLECTION_CASE',
      detail: `${openCollectionCases.length} caso(s) de cobrança ainda não resolvido(s).`,
      collectionCaseIds: openCollectionCases.map((c) => c.id),
    });
  }

  const utilityObligations = await UtilityObligation.findAll({ where: { contractId }, transaction });
  const obligationIds = utilityObligations.map((o) => o.id);
  if (obligationIds.length > 0) {
    const pendingTransfers = await OwnershipTransferTask.findAll({
      where: { utilityObligationId: { [Op.in]: obligationIds }, status: 'PENDING' },
      transaction,
    });
    if (pendingTransfers.length > 0) {
      reasons.push({
        type: 'PENDING_UTILITY_TRANSFER',
        detail: `${pendingTransfers.length} transferência(s) de titularidade de utilidade não concluída(s).`,
        ownershipTransferTaskIds: pendingTransfers.map((t) => t.id),
      });
    }
  }

  return reasons;
}

/**
 * closeoutContract — tenta encerrar (closeout) um contrato de locação. Se houver QUALQUER
 * pendência crítica retornada por `checkCloseoutEligibility`, bloqueia (409) e publica
 * `closeout.blocked` com os motivos. Se não houver pendência, libera e publica
 * `closeout.completed`. Nunca libera "por omissão" — fail-closed também aqui: qualquer
 * pendência encontrada bloqueia.
 */
async function closeoutContract(contractId, actorUserId, transaction) {
  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'CLOSEOUT_CONTRACT_NOT_FOUND');

  const reasons = await checkCloseoutEligibility(contractId, transaction);

  if (reasons.length > 0) {
    await publishCloseoutBlocked(contract, reasons, transaction);
    await registrarAuditoria(
      {
        groupId: contract.groupId,
        companyId: contract.companyId,
        actorUserId,
        action: 'billing.closeout.blocked',
        entityType: 'Contract',
        entityId: contract.id,
        afterJson: { reasons },
        reason: `Closeout do contrato ${contract.id} bloqueado por ${reasons.length} pendência(s) crítica(s).`,
      },
      transaction
    );
    throw AppError.conflict(
      'Não é possível encerrar a locação: há pendências críticas (cobrança em aberto e/ou transferência de utilidade não concluída).',
      'CLOSEOUT_BLOCKED',
      { reasons }
    );
  }

  await publishCloseoutCompleted(contract, transaction);
  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'billing.closeout.completed',
      entityType: 'Contract',
      entityId: contract.id,
      reason: `Closeout do contrato ${contract.id} concluído sem pendências críticas.`,
    },
    transaction
  );

  return { contractId: contract.id, status: 'COMPLETED' };
}

module.exports = { checkCloseoutEligibility, closeoutContract };
