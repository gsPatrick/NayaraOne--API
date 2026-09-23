'use strict';

const {
  UtilityObligation,
  UtilityAccount,
  UtilityReimbursement,
  OwnershipTransferTask,
  Contract,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { createFinancialEntry } = require('../finance/financialEntries.service');
const {
  publishUtilityTransferRequired,
  publishUtilityTransferCompleted,
  publishReimbursementCreated,
} = require('./billingEvents.service');

const UTILITY_TYPES = ['WATER', 'ELECTRICITY', 'GAS', 'CONDO', 'IPTU', 'SPU', 'OTHER'];
const RESPONSIBLE_PARTIES = ['LANDLORD', 'TENANT'];

async function createUtilityObligation(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, utilityType, responsibleParty, provider, accountNumber, transferRequired, evidenceFileId } = payload;
  if (!groupId || !companyId || !contractId || !utilityType || !responsibleParty) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "contractId", "utilityType" e "responsibleParty" são obrigatórios.',
      'UTILITY_OBLIGATION_VALIDATION'
    );
  }
  const normalizedType = String(utilityType).toUpperCase();
  const normalizedParty = String(responsibleParty).toUpperCase();
  if (!UTILITY_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`"utilityType" deve ser um de: ${UTILITY_TYPES.join(', ')}.`, 'UTILITY_OBLIGATION_VALIDATION');
  }
  if (!RESPONSIBLE_PARTIES.includes(normalizedParty)) {
    throw AppError.badRequest(`"responsibleParty" deve ser um de: ${RESPONSIBLE_PARTIES.join(', ')}.`, 'UTILITY_OBLIGATION_VALIDATION');
  }
  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'UTILITY_OBLIGATION_CONTRACT_NOT_FOUND');

  const obligation = await UtilityObligation.create(
    {
      groupId,
      companyId,
      contractId,
      utilityType: normalizedType,
      responsibleParty: normalizedParty,
      provider: provider || null,
      accountNumber: accountNumber || null,
      transferRequired: Boolean(transferRequired),
      evidenceFileId: evidenceFileId || null,
      status: transferRequired ? 'TRANSFER_PENDING' : 'ACTIVE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  let transferTask = null;
  if (obligation.transferRequired) {
    transferTask = await OwnershipTransferTask.create(
      {
        groupId,
        companyId,
        utilityObligationId: obligation.id,
        fromPersonId: payload.transferFromPersonId || null,
        toPersonId: payload.transferToPersonId || null,
        status: 'PENDING',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    await publishUtilityTransferRequired(transferTask, transaction);
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'billing.utility_obligation.create',
      entityType: 'UtilityObligation',
      entityId: obligation.id,
      afterJson: obligation.toJSON(),
      reason: `Obrigação de utilidade "${normalizedType}" criada, responsável: ${normalizedParty}.`,
    },
    transaction
  );

  return { obligation, transferTask };
}

async function getUtilityObligation(id, transaction) {
  const item = await UtilityObligation.findByPk(id, { transaction });
  if (!item) throw AppError.notFound('Obrigação de utilidade não encontrada.', 'UTILITY_OBLIGATION_NOT_FOUND');
  return item;
}

async function listUtilityObligations(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return UtilityObligation.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function createUtilityAccount(payload, actorUserId, transaction) {
  const { groupId, companyId, utilityObligationId, provider, accountNumber, holderPersonId } = payload;
  if (!groupId || !companyId || !utilityObligationId || !provider || !accountNumber) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "utilityObligationId", "provider" e "accountNumber" são obrigatórios.',
      'UTILITY_ACCOUNT_VALIDATION'
    );
  }
  await getUtilityObligation(utilityObligationId, transaction);

  const account = await UtilityAccount.create(
    {
      groupId,
      companyId,
      utilityObligationId,
      provider,
      accountNumber,
      holderPersonId: holderPersonId || null,
      status: 'ACTIVE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'billing.utility_account.create',
      entityType: 'UtilityAccount',
      entityId: account.id,
      afterJson: account.toJSON(),
      reason: `Conta de utilidade criada junto ao provedor "${provider}".`,
    },
    transaction
  );

  return account;
}

/**
 * completeOwnershipTransfer — marca a tarefa de transferência de titularidade como concluída,
 * e (quando não há outra tarefa pendente para a mesma obrigação) marca a obrigação como
 * TRANSFERRED.
 */
async function completeOwnershipTransfer(taskId, actorUserId, transaction) {
  const task = await OwnershipTransferTask.findByPk(taskId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!task) throw AppError.notFound('Tarefa de transferência não encontrada.', 'OWNERSHIP_TRANSFER_TASK_NOT_FOUND');
  if (task.status === 'COMPLETED') {
    throw AppError.conflict('Esta tarefa de transferência já está concluída.', 'OWNERSHIP_TRANSFER_TASK_ALREADY_COMPLETED');
  }
  const beforeJson = task.toJSON();
  task.status = 'COMPLETED';
  task.completedAt = new Date();
  task.updatedBy = actorUserId || null;
  await task.save({ transaction });

  // FIX (concorrência): quando uma obrigação tem MAIS DE UMA tarefa de transferência pendente,
  // "pendingCount === 0" era um COUNT sem lock na linha da obrigação — duas tasks da MESMA
  // obrigação sendo completadas ao mesmo tempo liam pendingCount=1 cada uma (a outra ainda não
  // tinha commitado sua própria conclusão) e NENHUMA das duas marcava a obrigação como
  // TRANSFERRED, mesmo as duas tarefas ficando COMPLETED ao final — obrigação travada em
  // TRANSFER_PENDING pra sempre. `lock: transaction.LOCK.UPDATE` na obrigação serializa as
  // conclusões concorrentes: a segunda só reavalia o COUNT depois que a primeira commitar, e aí
  // já enxerga a tarefa da primeira como COMPLETED.
  const obligation = await UtilityObligation.findByPk(task.utilityObligationId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!obligation) throw AppError.notFound('Obrigação de utilidade não encontrada.', 'UTILITY_OBLIGATION_NOT_FOUND');
  const pendingCount = await OwnershipTransferTask.count({
    where: { utilityObligationId: task.utilityObligationId, status: 'PENDING' },
    transaction,
  });
  if (pendingCount === 0) {
    obligation.status = 'TRANSFERRED';
    obligation.updatedBy = actorUserId || null;
    await obligation.save({ transaction });
  }

  await publishUtilityTransferCompleted(task, transaction);

  await registrarAuditoria(
    {
      groupId: task.groupId,
      companyId: task.companyId,
      actorUserId,
      action: 'billing.ownership_transfer_task.complete',
      entityType: 'OwnershipTransferTask',
      entityId: task.id,
      beforeJson,
      afterJson: task.toJSON(),
      reason: 'Transferência de titularidade de utilidade concluída.',
    },
    transaction
  );

  return task;
}

/**
 * recordUtilityPayment — a imobiliária paga uma conta de utilidade. Se `paidByParty` for
 * DIFERENTE do `responsibleParty` da obrigação, gera AUTOMATICAMENTE um
 * UtilityReimbursement (a receber da parte responsável) + FinancialEntry RECEIVABLE real —
 * nunca fica só um registro informativo sem lançamento contábil correspondente.
 */
async function recordUtilityPayment(utilityObligationId, payload, actorUserId, transaction) {
  const obligation = await getUtilityObligation(utilityObligationId, transaction);
  const { amount, paidByParty } = payload;
  if (amount === undefined || amount === null || !paidByParty) {
    throw AppError.badRequest('Os campos "amount" e "paidByParty" são obrigatórios.', 'UTILITY_PAYMENT_VALIDATION');
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw AppError.badRequest('"amount" deve ser um número positivo.', 'UTILITY_PAYMENT_VALIDATION');
  }
  const normalizedPaidBy = String(paidByParty).toUpperCase();

  if (normalizedPaidBy === obligation.responsibleParty) {
    // A parte certa pagou — nada a reembolsar, apenas confirma via auditoria.
    await registrarAuditoria(
      {
        groupId: obligation.groupId,
        companyId: obligation.companyId,
        actorUserId,
        action: 'billing.utility_payment.record',
        entityType: 'UtilityObligation',
        entityId: obligation.id,
        reason: `Pagamento de utilidade de ${numericAmount} registrado — pago pela parte responsável ("${normalizedPaidBy}"), sem reembolso.`,
      },
      transaction
    );
    return { reimbursement: null, financialEntry: null };
  }

  const owedByParty = obligation.responsibleParty;

  const financialEntry = await createFinancialEntry(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      contractId: obligation.contractId,
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount: numericAmount,
      description: `Reembolso de utilidade "${obligation.utilityType}" pago por "${normalizedPaidBy}", a cobrar de "${owedByParty}".`,
      dueAt: new Date(),
      idempotencyKey: `utility_reimbursement:${obligation.id}:${Date.now()}`,
    },
    actorUserId,
    transaction
  );

  const reimbursement = await UtilityReimbursement.create(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      utilityObligationId: obligation.id,
      paidByParty: normalizedPaidBy,
      owedByParty,
      amount: numericAmount,
      financialEntryId: financialEntry.id,
      status: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishReimbursementCreated(reimbursement, transaction);

  await registrarAuditoria(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      actorUserId,
      action: 'billing.utility_reimbursement.create',
      entityType: 'UtilityReimbursement',
      entityId: reimbursement.id,
      afterJson: reimbursement.toJSON(),
      reason: `Reembolso de ${numericAmount} criado: pago por "${normalizedPaidBy}", a cobrar de "${owedByParty}".`,
    },
    transaction
  );

  return { reimbursement, financialEntry };
}

module.exports = {
  createUtilityObligation,
  getUtilityObligation,
  listUtilityObligations,
  createUtilityAccount,
  completeOwnershipTransfer,
  recordUtilityPayment,
  UTILITY_TYPES,
  RESPONSIBLE_PARTIES,
};
