'use strict';

const { Contract, BillingSchedule, CollectionCase, OwnershipTransferTask, UtilityObligation } = require('../../models');
const { Op } = require('sequelize');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishCloseoutBlocked, publishCloseoutCompleted } = require('./billingEvents.service');
const contractsService = require('../legal/contracts.service');

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

  // FIX DIVERGÊNCIA (auditoria técnica da cliente, 07/10/2026): closeout financeiro concluído
  // (sem pendência crítica) NÃO fazia o Contract avançar na máquina de estados jurídica — o
  // encerramento financeiro (Billing) e o encerramento jurídico (Contract.status) viviam
  // desconectados, apesar de serem o MESMO evento de negócio ("a locação terminou"). Agora que
  // SUSPENDED/TERMINATED/CLOSED existem de fato na máquina de estados (contracts.service.js),
  // o closeout sem pendências avança o contrato ATÉ CLOSED (passando por TERMINATED quando
  // aplicável), reusando os MESMOS gates de terminateContract/closeContract (ex.: garantia ACTIVE
  // pendente, processo jurídico aberto) — fail closed também aqui: se esses gates bloquearem, o
  // closeout financeiro já foi registrado como COMPLETED (não há pendência financeira), mas o
  // arquivamento jurídico fica pendente e é reportado separadamente, sem reverter o que já foi
  // liberado no Financeiro.
  //
  // Contratos que nunca chegaram a ACTIVE/SUSPENDED (ex.: DRAFT em testes antigos que só testam
  // a parte financeira do closeout) simplesmente não têm transição de TERMINATED disponível a
  // partir do seu status atual — VALID_TRANSITIONS não inclui a saída, então nenhuma tentativa é
  // feita (comportamento idêntico ao anterior, sem quebrar nada).
  let contractLifecycle = null;
  if (contractsService.VALID_TRANSITIONS[contract.status]?.includes('TERMINATED')) {
    try {
      const terminated = await contractsService.terminateContract(
        contract.id,
        'Closeout financeiro concluído sem pendências críticas — encerramento automático.',
        actorUserId,
        transaction
      );
      const closed = await contractsService.closeContract(
        terminated.id,
        'Closeout financeiro concluído — arquivamento operacional automático.',
        actorUserId,
        transaction
      );
      contractLifecycle = closed.status;
    } catch (err) {
      // Não reverte o closeout financeiro (já legitimamente concluído) — só reporta que o
      // encerramento jurídico do Contract ficou pendente de ação manual (ex.: garantia ACTIVE
      // ainda não liberada, processo jurídico aberto).
      contractLifecycle = { blocked: true, code: err.code, message: err.message };
    }
  }

  return { contractId: contract.id, status: 'COMPLETED', contractLifecycle };
}

module.exports = { checkCloseoutEligibility, closeoutContract };
