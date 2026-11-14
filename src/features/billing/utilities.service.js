'use strict';

const { UtilityObligation, UtilityAccount, OwnershipTransferTask, Contract, File } = require('../../models');
const AppError = require('../../utils/AppError');
const { assertUuid, assertText } = require('../../utils/inputGuards');
const { assertCompanyPerson, assertCompanyFile } = require('./utilityInputGuards');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishUtilityTransferRequired, publishUtilityTransferCompleted } = require('./billingEvents.service');
const { resolvePeriodicity } = require('./leaseObligationSchedule');

const UTILITY_TYPES = ['WATER', 'ELECTRICITY', 'GAS', 'CONDO', 'IPTU', 'SPU', 'OTHER'];
const RESPONSIBLE_PARTIES = ['LANDLORD', 'TENANT'];
// Pagamento de um vencimento (comprovante, reembolso e lançamento a receber): obligations/utilityPayment.service.js.

async function createUtilityObligation(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, utilityType, responsibleParty, provider, accountNumber, transferRequired, evidenceFileId } = payload;
  if (!groupId || !companyId || !contractId || !utilityType || !responsibleParty) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "contractId", "utilityType" e "responsibleParty" são obrigatórios.',
      'UTILITY_OBLIGATION_VALIDATION'
    );
  }
  assertUuid(contractId, 'contractId', 'UTILITY_OBLIGATION_VALIDATION');
  assertText(utilityType, 'utilityType', 32, 'UTILITY_OBLIGATION_VALIDATION');
  assertText(responsibleParty, 'responsibleParty', 16, 'UTILITY_OBLIGATION_VALIDATION');
  assertText(provider, 'provider', 120, 'UTILITY_OBLIGATION_VALIDATION');
  assertText(accountNumber, 'accountNumber', 60, 'UTILITY_OBLIGATION_VALIDATION');
  await assertCompanyFile(evidenceFileId, companyId, 'evidenceFileId', 'UTILITY_OBLIGATION_EVIDENCE_NOT_FOUND', transaction);
  await assertCompanyPerson(payload.transferFromPersonId, 'transferFromPersonId', 'UTILITY_OBLIGATION_VALIDATION', transaction);
  await assertCompanyPerson(payload.transferToPersonId, 'transferToPersonId', 'UTILITY_OBLIGATION_VALIDATION', transaction);
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
  // Fechamento M5 (Caderno §12): toda obrigação tem periodicidade (informada ou o padrão configurado por tipo).
  const schedule = await resolvePeriodicity(normalizedType, payload, { groupId, companyId }, transaction);

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
      periodicity: schedule.periodicity,
      dueDay: schedule.dueDay,
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
  const obligations = await UtilityObligation.findAll({ where, order: [['created_at', 'DESC']], transaction });
  if (obligations.length === 0) return [];
  const tasks = await OwnershipTransferTask.findAll({
    where: { utilityObligationId: obligations.map((o) => o.id) },
    order: [['created_at', 'DESC']],
    transaction,
  });
  return obligations.map((obligation) => ({
    ...obligation.toJSON(),
    transferTasks: tasks.filter((t) => t.utilityObligationId === obligation.id).map((t) => t.toJSON()),
  }));
}

/**
 * requestOwnershipTransfer — abre a tarefa de transferência de titularidade numa obrigação que
 * já existe (o caderno trata a troca de titularidade como tarefa com evidência). A obrigação
 * passa a TRANSFER_PENDING e o encerramento do contrato fica bloqueado até a conclusão.
 */
async function requestOwnershipTransfer(utilityObligationId, payload, actorUserId, transaction) {
  assertUuid(utilityObligationId, 'id', 'UTILITY_OBLIGATION_VALIDATION');
  await assertCompanyPerson(payload && payload.fromPersonId, 'fromPersonId', 'OWNERSHIP_TRANSFER_VALIDATION', transaction);
  await assertCompanyPerson(payload && payload.toPersonId, 'toPersonId', 'OWNERSHIP_TRANSFER_VALIDATION', transaction);
  const obligation = await UtilityObligation.findByPk(utilityObligationId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!obligation) throw AppError.notFound('Obrigação de utilidade não encontrada.', 'UTILITY_OBLIGATION_NOT_FOUND');

  const pending = await OwnershipTransferTask.count({
    where: { utilityObligationId: obligation.id, status: 'PENDING' },
    transaction,
  });
  if (pending > 0) {
    throw AppError.conflict('Já existe uma transferência de titularidade pendente para esta obrigação.', 'OWNERSHIP_TRANSFER_ALREADY_PENDING');
  }

  const beforeJson = obligation.toJSON();
  const task = await OwnershipTransferTask.create(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      utilityObligationId: obligation.id,
      fromPersonId: payload?.fromPersonId || null,
      toPersonId: payload?.toPersonId || null,
      status: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  obligation.transferRequired = true;
  obligation.status = 'TRANSFER_PENDING';
  obligation.updatedBy = actorUserId || null;
  await obligation.save({ transaction });

  await publishUtilityTransferRequired(task, transaction);
  await registrarAuditoria(
    {
      groupId: obligation.groupId,
      companyId: obligation.companyId,
      actorUserId,
      action: 'billing.ownership_transfer.request',
      entityType: 'UtilityObligation',
      entityId: obligation.id,
      beforeJson,
      afterJson: obligation.toJSON(),
      reason: 'Transferência de titularidade de utilidade solicitada.',
    },
    transaction
  );

  return { obligation, transferTask: task };
}

async function createUtilityAccount(payload, actorUserId, transaction) {
  const { groupId, companyId, utilityObligationId, provider, accountNumber, holderPersonId } = payload;
  if (!groupId || !companyId || !utilityObligationId || !provider || !accountNumber) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "utilityObligationId", "provider" e "accountNumber" são obrigatórios.',
      'UTILITY_ACCOUNT_VALIDATION'
    );
  }
  assertUuid(utilityObligationId, 'utilityObligationId', 'UTILITY_ACCOUNT_VALIDATION');
  assertText(provider, 'provider', 120, 'UTILITY_ACCOUNT_VALIDATION');
  assertText(accountNumber, 'accountNumber', 60, 'UTILITY_ACCOUNT_VALIDATION');
  await assertCompanyPerson(holderPersonId, 'holderPersonId', 'UTILITY_ACCOUNT_VALIDATION', transaction);
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
async function completeOwnershipTransfer(taskId, payload, actorUserId, transaction) {
  const task = await OwnershipTransferTask.findByPk(taskId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!task) throw AppError.notFound('Tarefa de transferência não encontrada.', 'OWNERSHIP_TRANSFER_TASK_NOT_FOUND');
  if (task.status === 'COMPLETED') {
    throw AppError.conflict('Esta tarefa de transferência já está concluída.', 'OWNERSHIP_TRANSFER_TASK_ALREADY_COMPLETED');
  }

  // ACHADO REAL (auditoria independente Nayara, A05): a conclusão não exigia nenhum comprovante
  // nem destinatário informado — uma transferência de titularidade podia ser marcada concluída
  // sem evidência nenhuma de que ela de fato aconteceu. Fail closed: exige os dois.
  const evidenceFileId = payload?.evidenceFileId || null;
  const toPersonId = payload?.toPersonId || task.toPersonId || null;
  assertUuid(evidenceFileId, 'evidenceFileId', 'OWNERSHIP_TRANSFER_EVIDENCE_NOT_FOUND', { optional: true });
  await assertCompanyPerson(payload?.toPersonId, 'toPersonId', 'OWNERSHIP_TRANSFER_RECIPIENT_REQUIRED', transaction);
  if (!evidenceFileId) {
    throw AppError.badRequest(
      'É preciso anexar o comprovante da transferência de titularidade antes de concluir.',
      'OWNERSHIP_TRANSFER_EVIDENCE_REQUIRED'
    );
  }
  if (!toPersonId) {
    throw AppError.badRequest(
      'É preciso informar quem é o novo titular antes de concluir a transferência.',
      'OWNERSHIP_TRANSFER_RECIPIENT_REQUIRED'
    );
  }
  const evidenceFile = await File.findOne({ where: { id: evidenceFileId, companyId: task.companyId }, transaction });
  if (!evidenceFile) {
    throw AppError.badRequest(
      'O comprovante informado não existe ou não pertence a esta empresa.',
      'OWNERSHIP_TRANSFER_EVIDENCE_NOT_FOUND'
    );
  }

  const beforeJson = task.toJSON();
  task.status = 'COMPLETED';
  task.completedAt = new Date();
  task.evidenceFileId = evidenceFileId;
  task.toPersonId = toPersonId;
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
    obligation.evidenceFileId = evidenceFileId;
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
 * Obrigação locatícia vencida (livro §12/§18, DEC-074): ciclo sem comprovante, troca de titularidade atrasada e reembolso não
 * recebido publicam lease.obligation.overdue (uma vez por pendência) e abrem alerta e cobrança — obligations/leaseObligationOverdue.js.
 * Mantido com este nome porque o job da cobrança e o módulo jurídico (lease-obligation.service) já o chamam.
 */
async function flagOverdueLeaseObligations(transaction, options = {}) {
  const { processLeaseObligations } = require('./obligations/leaseObligationOverdue');
  return processLeaseObligations(transaction, options);
}

module.exports = {
  flagOverdueLeaseObligations,
  createUtilityObligation,
  getUtilityObligation,
  listUtilityObligations,
  createUtilityAccount,
  completeOwnershipTransfer,
  requestOwnershipTransfer,
  recordUtilityPayment: (...args) => require('./obligations/utilityPayment.service').recordUtilityPayment(...args),
  UTILITY_TYPES,
  RESPONSIBLE_PARTIES,
};
