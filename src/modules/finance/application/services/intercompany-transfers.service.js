'use strict';

const { IntercompanyTransfer, Company, BankAccount, File } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { publishDomainEvent } = require('../../../../engines/events/outbox');
const { createFinancialEntry } = require('./financial-entry.service');
const { assertBankAccountEligibleForPayment } = require('./finance-antifraud.service');
const { withCompanyContext } = require('./intercompany-company-context');
const { getGroupConsolidatedReport } = require('./intercompany-group-report.service');
const { listDestinationBankAccounts, listDestinationCompanies } = require('./intercompany-destinations.service');

// M4-18 / Caderno §15 — Transferências entre empresas do grupo.
//
// "Transferência intercompany cria dois lados vinculados por intercompany_transfer_id, motivo,
// documento, aprovação e contas correspondentes. Relatório consolidado elimina a duplicidade
// apenas na apresentação."
//
// Fluxo (conferência Nayara 18/10/2026 — antes o motivo era opcional, não havia documento nem
// aprovação, e os dois lançamentos nasciam na hora do pedido):
//   1. createIntercompanyTransfer — o solicitante registra o PEDIDO (PENDING_APPROVAL) com motivo,
//      documento comprobatório (arquivo real da empresa de origem) e a conta bancária de cada
//      lado. Nenhum lançamento é criado: nada se move sem aprovação.
//   2. approveIntercompanyTransfer — OUTRA pessoa com `finance:approve` aprova; só então os dois
//      lados nascem, na MESMA transação (DEBIT na origem, CREDIT no destino), cada um na conta
//      bancária da sua empresa. Quem pediu nunca aprova (maker-checker, também garantido por
//      CHECK no banco).
//   3. rejectIntercompanyTransfer — recusa com motivo; nenhum lançamento é criado.
//   4. reconcileIntercompanyTransfer — confirma a chegada no destino (PENDING -> RECONCILED).
//   5. getGroupConsolidatedReport — visão da diretoria: soma as empresas do grupo e elimina os
//      dois lados de cada transferência (não é receita nem despesa do grupo), sem tocar ledger.
//
// RLS: a linha de transferência pertence à empresa de ORIGEM (CHECK company_id = from_company_id).
// O lançamento e a conta do destino são lidos/criados assumindo o contexto do destino via SET
// LOCAL dentro da mesma transação e restaurando em seguida — continua sujeito à policy, só troca
// explicitamente de empresa dentro do grupo.

const TRANSFER_STATUSES = ['PENDING_APPROVAL', 'REJECTED', 'PENDING', 'RECONCILED'];

async function getIntercompanyTransfer(id, transaction, options = {}) {
  const transfer = await IntercompanyTransfer.findByPk(id, {
    transaction,
    lock: options.lock && transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!transfer) {
    throw AppError.notFound('Transferência entre empresas não encontrada.', 'FINANCE_INTERCOMPANY_NOT_FOUND');
  }
  return transfer;
}

async function assertBankAccountOfCompany(bankAccountId, companyId, field, transaction) {
  const account = await BankAccount.findByPk(bankAccountId, { transaction });
  if (!account || account.companyId !== companyId) {
    throw AppError.badRequest(
      `A conta bancária informada em "${field}" não existe na empresa correspondente — cada lado usa uma conta da própria empresa.`,
      'FINANCE_INTERCOMPANY_BANK_ACCOUNT_INVALID'
    );
  }
  if (account.status === 'BLOCKED') {
    throw AppError.conflict(`A conta bancária informada em "${field}" está bloqueada.`, 'FINANCE_INTERCOMPANY_BANK_ACCOUNT_INVALID');
  }
  return account;
}

async function createIntercompanyTransfer(payload, actorUserId, transaction) {
  const { groupId, companyId, toCompanyId, amount, reason, dueAt, evidenceFileId, fromBankAccountId, toBankAccountId } = payload;
  // `companyId` vem do contexto de tenant (withTenant no controller) e É a empresa de origem.
  const fromCompanyId = payload.fromCompanyId || companyId;

  if (!groupId || !fromCompanyId || !toCompanyId || amount === undefined || amount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "fromCompanyId" (ou o contexto da empresa atual), "toCompanyId" e "amount" são obrigatórios.',
      'FINANCE_INTERCOMPANY_VALIDATION'
    );
  }
  if (fromCompanyId !== companyId) {
    throw AppError.forbidden(
      'A transferência só pode ser originada pela empresa do contexto atual — troque de empresa para transferir a partir dela.',
      'FINANCE_INTERCOMPANY_ORIGIN_MISMATCH'
    );
  }
  if (fromCompanyId === toCompanyId) {
    throw AppError.badRequest('A empresa de origem e a de destino precisam ser diferentes.', 'FINANCE_INTERCOMPANY_SAME_COMPANY');
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw AppError.badRequest('O campo "amount" deve ser um número positivo.', 'FINANCE_INTERCOMPANY_VALIDATION');
  }
  const normalizedReason = reason === undefined || reason === null ? '' : String(reason).trim();
  if (!normalizedReason) {
    throw AppError.badRequest('O motivo da transferência ("reason") é obrigatório (Caderno §15).', 'FINANCE_INTERCOMPANY_REASON_REQUIRED');
  }
  if (!evidenceFileId) {
    throw AppError.badRequest(
      'Anexe o documento comprobatório da transferência: ele é obrigatório.',
      'FINANCE_INTERCOMPANY_EVIDENCE_REQUIRED'
    );
  }
  if (!fromBankAccountId || !toBankAccountId) {
    throw AppError.badRequest(
      'Informe a conta bancária de cada lado da transferência: a da empresa de origem e a da empresa de destino.',
      'FINANCE_INTERCOMPANY_BANK_ACCOUNTS_REQUIRED'
    );
  }

  // Destino do MESMO grupo (core.companies tem RLS por grupo; a checagem explícita fecha o caso).
  const destination = await Company.findByPk(toCompanyId, { transaction });
  if (!destination || destination.groupId !== groupId) {
    throw AppError.badRequest('A empresa de destino não existe ou não pertence a este grupo.', 'FINANCE_INTERCOMPANY_DESTINATION_INVALID');
  }

  // Documento: arquivo real (não apagado) da empresa de origem.
  const evidence = await File.findOne({ where: { id: evidenceFileId, companyId: fromCompanyId }, transaction });
  if (!evidence) {
    throw AppError.badRequest(
      'O documento comprobatório informado não existe nesta empresa — envie o arquivo antes de pedir a transferência.',
      'FINANCE_INTERCOMPANY_EVIDENCE_NOT_FOUND'
    );
  }

  await assertBankAccountOfCompany(fromBankAccountId, fromCompanyId, 'fromBankAccountId', transaction);
  await withCompanyContext(toCompanyId, fromCompanyId, transaction, () =>
    assertBankAccountOfCompany(toBankAccountId, toCompanyId, 'toBankAccountId', transaction)
  );

  const transfer = await IntercompanyTransfer.create(
    {
      groupId,
      companyId: fromCompanyId,
      fromCompanyId,
      toCompanyId,
      amount: numericAmount,
      reason: normalizedReason,
      status: 'PENDING_APPROVAL',
      fromEntryId: null,
      toEntryId: null,
      evidenceFileId,
      fromBankAccountId,
      toBankAccountId,
      requestedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId: fromCompanyId,
      actorUserId,
      action: 'finance.intercompany_transfer.request',
      entityType: 'IntercompanyTransfer',
      entityId: transfer.id,
      afterJson: { transfer: transfer.toJSON(), dueAt: dueAt || null },
      reason: `Pedido de transferência de ${numericAmount} da empresa ${fromCompanyId} para ${toCompanyId} aguardando aprovação: ${normalizedReason}`,
    },
    transaction
  );

  return { transfer };
}

/**
 * approveIntercompanyTransfer — outra pessoa aprova; só aqui os dois lados nascem, na mesma
 * transação, cada um na conta da sua empresa. Qualquer falha desfaz tudo.
 */
async function approveIntercompanyTransfer(id, payload, actorUserId, transaction) {
  const transfer = await getIntercompanyTransfer(id, transaction, { lock: true });
  if (transfer.status !== 'PENDING_APPROVAL') {
    throw AppError.conflict(
      `Só é possível aprovar uma transferência aguardando aprovação (atual: "${transfer.status}").`,
      'FINANCE_INTERCOMPANY_INVALID_STATUS'
    );
  }
  if (!actorUserId || !transfer.requestedByUserId || String(transfer.requestedByUserId) === String(actorUserId)) {
    throw AppError.forbidden(
      'Quem pediu a transferência não pode aprová-la — a aprovação precisa ser de outra pessoa (maker-checker).',
      'FINANCE_INTERCOMPANY_SELF_APPROVAL_FORBIDDEN'
    );
  }

  const { groupId, fromCompanyId, toCompanyId } = transfer;
  const numericAmount = Number(transfer.amount);
  const dueAt = (payload && payload.dueAt) || null;
  const description = `Transferência entre empresas: ${transfer.reason}`;

  // Dinheiro saindo da origem: a conta precisa estar elegível a pagamento (cooldown/bloqueio).
  await assertBankAccountEligibleForPayment(transfer.fromBankAccountId, transaction);

  const fromEntry = await createFinancialEntry(
    {
      groupId,
      companyId: fromCompanyId,
      bankAccountId: transfer.fromBankAccountId,
      entryType: 'DEBIT',
      nature: 'ADJUSTMENT',
      amount: numericAmount,
      description,
      dueAt,
      idempotencyKey: `intercompany-transfer:${transfer.id}:from`,
    },
    actorUserId,
    transaction
  );

  const toEntry = await withCompanyContext(toCompanyId, fromCompanyId, transaction, () =>
    createFinancialEntry(
      {
        groupId,
        companyId: toCompanyId,
        bankAccountId: transfer.toBankAccountId,
        entryType: 'CREDIT',
        nature: 'ADJUSTMENT',
        amount: numericAmount,
        description,
        dueAt,
        idempotencyKey: `intercompany-transfer:${transfer.id}:to`,
      },
      actorUserId,
      transaction
    )
  );

  const beforeJson = transfer.toJSON();
  transfer.status = 'PENDING';
  transfer.fromEntryId = fromEntry.id;
  transfer.toEntryId = toEntry.id;
  transfer.approvedByUserId = actorUserId;
  transfer.approvedAt = new Date();
  transfer.updatedBy = actorUserId;
  await transfer.save({ transaction });

  await publishDomainEvent(
    {
      groupId,
      companyId: fromCompanyId,
      aggregateType: 'IntercompanyTransfer',
      aggregateId: transfer.id,
      eventType: 'finance.intercompany_transfer.approved',
      payload: { id: transfer.id, amount: transfer.amount, fromCompanyId, toCompanyId, fromEntryId: fromEntry.id, toEntryId: toEntry.id },
      idempotencyKey: `finance.intercompany_transfer.approved:${transfer.id}`,
    },
    transaction
  );

  await registrarAuditoria(
    {
      groupId,
      companyId: fromCompanyId,
      actorUserId,
      action: 'finance.intercompany_transfer.approve',
      entityType: 'IntercompanyTransfer',
      entityId: transfer.id,
      beforeJson,
      afterJson: { transfer: transfer.toJSON(), fromEntryId: fromEntry.id, toEntryId: toEntry.id },
      reason: `Transferência de ${numericAmount} aprovada por outra pessoa — lançamentos ${fromEntry.id} (saída) e ${toEntry.id} (entrada) criados na mesma transação.`,
    },
    transaction
  );

  return { transfer, fromEntry, toEntry };
}

async function rejectIntercompanyTransfer(id, payload, actorUserId, transaction) {
  const transfer = await getIntercompanyTransfer(id, transaction, { lock: true });
  if (transfer.status !== 'PENDING_APPROVAL') {
    throw AppError.conflict(
      `Só é possível recusar uma transferência aguardando aprovação (atual: "${transfer.status}").`,
      'FINANCE_INTERCOMPANY_INVALID_STATUS'
    );
  }
  const reasonText = payload && payload.reason ? String(payload.reason).trim() : '';
  if (!reasonText) {
    throw AppError.badRequest('Informe o motivo da recusa.', 'FINANCE_INTERCOMPANY_REJECTION_REASON_REQUIRED');
  }
  const beforeJson = transfer.toJSON();
  transfer.status = 'REJECTED';
  transfer.rejectedByUserId = actorUserId || null;
  transfer.rejectedAt = new Date();
  transfer.rejectionReason = reasonText;
  transfer.updatedBy = actorUserId || null;
  await transfer.save({ transaction });

  await registrarAuditoria(
    {
      groupId: transfer.groupId,
      companyId: transfer.companyId,
      actorUserId,
      action: 'finance.intercompany_transfer.reject',
      entityType: 'IntercompanyTransfer',
      entityId: transfer.id,
      beforeJson,
      afterJson: transfer.toJSON(),
      reason: `Transferência recusada: ${reasonText}`,
    },
    transaction
  );
  return transfer;
}

async function listIntercompanyTransfers(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.toCompanyId) where.toCompanyId = filters.toCompanyId;
  return IntercompanyTransfer.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

/**
 * reconcileIntercompanyTransfer — marca RECONCILED quando a entrada foi confirmada no destino.
 * Só depois de aprovada (os dois lados existem). Não mexe em valor de lançamento (FIN-003).
 */
async function reconcileIntercompanyTransfer(id, actorUserId, transaction) {
  const transfer = await getIntercompanyTransfer(id, transaction, { lock: true });
  if (transfer.status === 'RECONCILED') {
    throw AppError.conflict('Esta transferência já foi conciliada.', 'FINANCE_INTERCOMPANY_ALREADY_RECONCILED');
  }
  if (transfer.status !== 'PENDING') {
    throw AppError.conflict(
      `Só é possível conciliar uma transferência aprovada (atual: "${transfer.status}").`,
      'FINANCE_INTERCOMPANY_INVALID_STATUS'
    );
  }
  const beforeJson = transfer.toJSON();
  transfer.status = 'RECONCILED';
  transfer.reconciledAt = new Date();
  transfer.reconciledByUserId = actorUserId || null;
  transfer.updatedBy = actorUserId || null;
  await transfer.save({ transaction });

  await registrarAuditoria(
    {
      groupId: transfer.groupId,
      companyId: transfer.companyId,
      actorUserId,
      action: 'finance.intercompany_transfer.reconcile',
      entityType: 'IntercompanyTransfer',
      entityId: transfer.id,
      beforeJson,
      afterJson: transfer.toJSON(),
      reason: `Transferência entre empresas de ${transfer.amount} conciliada (entrada confirmada no destino).`,
    },
    transaction
  );

  return transfer;
}

module.exports = {
  listDestinationCompanies,
  listDestinationBankAccounts,
  createIntercompanyTransfer,
  approveIntercompanyTransfer,
  rejectIntercompanyTransfer,
  listIntercompanyTransfers,
  getIntercompanyTransfer,
  reconcileIntercompanyTransfer,
  getGroupConsolidatedReport,
  TRANSFER_STATUSES,
};
