'use strict';

const crypto = require('crypto');

const { PaymentIntent, FinancialEntry } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getFinancialEntry, settleFinancialEntry } = require('./financialEntries.service');
const { isApprovalRequestApproved, getApprovalRequest } = require('./approvals.service');

// M4-07 — Payment intent com snapshot e hash dos dados aprovados.
//
// O que já existia: lock otimista (`lock_version`) comparado na hora de decidir uma aprovação
// (approvals.service.js) — detecta "mudou desde que eu revisei", mas não guarda O QUE foi
// revisado. A ressalva estava escrita em financeAntifraud.service.js: "finance.approval_requests
// NÃO tem uma coluna snapshot_hash".
//
// O que esta camada acrescenta (03_MOTORES_TRANSVERSAIS.md: "quem executa valida o hash
// aprovado"): a intenção de pagamento congela uma CÓPIA completa dos campos que importam para
// pagar (valor, conta bancária de destino, descrição, vencimento, natureza, classificação
// contábil, marcação de dinheiro de terceiro) e o SHA-256 dessa cópia. Aprovar recalcula o
// hash sobre o estado ATUAL do lançamento: se um único desses campos mudou depois do snapshot,
// a aprovação é RECUSADA — mesmo espírito do FINANCE_APPROVAL_STALE, mas com prova do que
// mudou (o snapshot fica gravado).

const STATUSES = ['PENDING', 'APPROVED', 'EXECUTED', 'CANCELLED'];

/**
 * buildEntrySnapshot — extrai do lançamento exatamente os campos que, se mudarem, mudam o
 * significado do pagamento. Campos puramente operacionais (updated_at, lock_version,
 * updated_by) ficam de fora de propósito: eles mudam por qualquer edição inócua e fariam o
 * hash divergir sem que nada de relevante para o dinheiro tivesse mudado.
 *
 * Valores são normalizados para string (DECIMAL vem do driver como string e de uma criação
 * recém-feita pode vir como number; datas viram ISO) para que o hash seja estável entre um
 * objeto recém-criado e o mesmo registro relido do banco.
 */
function buildEntrySnapshot(entry) {
  const asString = (value) => (value === null || value === undefined ? null : String(value));
  const asIso = (value) => (value ? new Date(value).toISOString() : null);
  return {
    financialEntryId: entry.id,
    groupId: entry.groupId,
    companyId: entry.companyId,
    bankAccountId: entry.bankAccountId || null,
    costCenterId: entry.costCenterId || null,
    resultCenterId: entry.resultCenterId || null,
    chartOfAccountId: entry.chartOfAccountId || null,
    contractId: entry.contractId || null,
    entryType: entry.entryType,
    nature: entry.nature,
    amount: asString(Number(entry.amount).toFixed(2)),
    description: entry.description || null,
    dueAt: asIso(entry.dueAt),
    status: entry.status,
    isThirdPartyFunds: Boolean(entry.isThirdPartyFunds),
    thirdPartyReference: entry.thirdPartyReference || null,
  };
}

/**
 * computeSnapshotHash — SHA-256 sobre uma serialização CANÔNICA (chaves ordenadas) do
 * snapshot. Mesmo padrão de computeContentHash em legal/contractVersions.service.js, com a
 * ordenação explícita porque aqui o objeto é montado programaticamente e a ordem das chaves
 * não pode ser a fonte da diferença entre dois hashes.
 */
function computeSnapshotHash(snapshot) {
  const canonical = JSON.stringify(
    Object.keys(snapshot)
      .sort()
      .reduce((acc, key) => {
        acc[key] = snapshot[key];
        return acc;
      }, {})
  );
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function getPaymentIntent(id, transaction) {
  const intent = await PaymentIntent.findByPk(id, { transaction });
  if (!intent) throw AppError.notFound('Intenção de pagamento não encontrada.', 'FINANCE_PAYMENT_INTENT_NOT_FOUND');
  return intent;
}

async function createPaymentIntent(payload, actorUserId, transaction) {
  const { financialEntryId, approvalRequestId } = payload;
  if (!financialEntryId) {
    throw AppError.badRequest('O campo "financialEntryId" é obrigatório.', 'FINANCE_PAYMENT_INTENT_VALIDATION');
  }

  // Relê o lançamento do banco (em vez de confiar num objeto passado pelo chamador) para que o
  // snapshot represente o estado PERSISTIDO — é esse estado que a aprovação vai reconferir.
  const entry = await getFinancialEntry(financialEntryId, transaction);
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(
      `Só é possível criar intenção de pagamento para um lançamento PENDING (atual: "${entry.status}").`,
      'FINANCE_PAYMENT_INTENT_INVALID_ENTRY_STATUS'
    );
  }

  const existing = await PaymentIntent.findOne({
    where: { financialEntryId, status: ['PENDING', 'APPROVED'] },
    transaction,
  });
  if (existing) {
    throw AppError.conflict(
      'Já existe uma intenção de pagamento em aberto para este lançamento.',
      'FINANCE_PAYMENT_INTENT_ALREADY_OPEN',
      { existingId: existing.id }
    );
  }

  if (approvalRequestId) {
    const approvalRequest = await getApprovalRequest(approvalRequestId, transaction);
    if (approvalRequest.relatedEntityId !== entry.id) {
      throw AppError.badRequest(
        'A solicitação de aprovação informada não se refere a este lançamento.',
        'FINANCE_PAYMENT_INTENT_VALIDATION'
      );
    }
  }

  const snapshot = buildEntrySnapshot(entry);
  const intent = await PaymentIntent.create(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      financialEntryId: entry.id,
      snapshotJson: snapshot,
      snapshotHash: computeSnapshotHash(snapshot),
      status: 'PENDING',
      approvalRequestId: approvalRequestId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.payment_intent.create',
      entityType: 'PaymentIntent',
      entityId: intent.id,
      afterJson: intent.toJSON(),
      reason: `Intenção de pagamento criada para o lançamento ${entry.id} (${snapshot.amount}) — snapshot ${intent.snapshotHash.slice(0, 12)}.`,
    },
    transaction
  );

  return intent;
}

/**
 * approvePaymentIntent — recalcula o hash sobre o estado ATUAL do lançamento e compara com o
 * hash gravado. Divergiu = o lançamento mudou depois que a intenção foi proposta, e aprovar
 * seria aprovar outra coisa: recusa com FINANCE_PAYMENT_INTENT_STALE.
 *
 * Maker-checker: quem criou a intenção não pode aprová-la (mesma regra de
 * approvals.decideApprovalStep). Se a intenção estiver amarrada a uma ApprovalRequest, essa
 * solicitação precisa estar APPROVED — a intenção não substitui a dupla aprovação, ela a
 * complementa com a prova do conteúdo.
 */
async function approvePaymentIntent(id, actorUserId, transaction) {
  const intent = await getPaymentIntent(id, transaction);
  if (intent.status !== 'PENDING') {
    throw AppError.conflict(
      `Só é possível aprovar uma intenção PENDING (atual: "${intent.status}").`,
      'FINANCE_PAYMENT_INTENT_INVALID_STATUS'
    );
  }
  if (intent.createdBy && actorUserId && intent.createdBy === actorUserId) {
    throw AppError.forbidden(
      'Quem criou a intenção de pagamento não pode aprová-la (segregação de funções — maker-checker).',
      'FINANCE_PAYMENT_INTENT_SELF_APPROVAL_FORBIDDEN'
    );
  }

  const entry = await getFinancialEntry(intent.financialEntryId, transaction);
  const currentSnapshot = buildEntrySnapshot(entry);
  const currentHash = computeSnapshotHash(currentSnapshot);
  if (currentHash !== intent.snapshotHash) {
    const changedFields = Object.keys(currentSnapshot).filter(
      (key) => JSON.stringify(currentSnapshot[key]) !== JSON.stringify(intent.snapshotJson[key])
    );
    throw AppError.conflict(
      `O lançamento foi alterado depois que esta intenção de pagamento foi criada (campos divergentes: ${changedFields.join(', ') || 'desconhecidos'}) — aprovação recusada por segurança. Crie uma nova intenção sobre os dados atuais.`,
      'FINANCE_PAYMENT_INTENT_STALE',
      { expectedHash: intent.snapshotHash, currentHash, changedFields }
    );
  }

  if (intent.approvalRequestId) {
    const approved = await isApprovalRequestApproved('FinancialEntry', intent.financialEntryId, transaction);
    if (!approved) {
      throw AppError.conflict(
        'A solicitação de aprovação vinculada a esta intenção ainda não foi aprovada (maker-checker pendente).',
        'FINANCE_PAYMENT_INTENT_APPROVAL_PENDING'
      );
    }
  }

  const beforeJson = intent.toJSON();
  intent.status = 'APPROVED';
  intent.approvedByUserId = actorUserId || null;
  intent.approvedAt = new Date();
  intent.updatedBy = actorUserId || null;
  await intent.save({ transaction });

  await registrarAuditoria(
    {
      groupId: intent.groupId,
      companyId: intent.companyId,
      actorUserId,
      action: 'finance.payment_intent.approve',
      entityType: 'PaymentIntent',
      entityId: intent.id,
      beforeJson,
      afterJson: intent.toJSON(),
      reason: `Intenção de pagamento aprovada — hash do snapshot conferido contra o estado atual do lançamento (${intent.snapshotHash.slice(0, 12)}).`,
    },
    transaction
  );

  return intent;
}

/**
 * executePaymentIntent — só executa a partir de APPROVED, e reconfere o hash uma última vez
 * (entre aprovar e executar o lançamento também pode mudar). Liquidar é delegado a
 * settleFinancialEntry, que mantém as validações antifraude de conta bancária.
 */
async function executePaymentIntent(id, actorUserId, transaction) {
  const intent = await getPaymentIntent(id, transaction);
  if (intent.status !== 'APPROVED') {
    throw AppError.conflict(
      `Só é possível executar uma intenção APPROVED (atual: "${intent.status}").`,
      'FINANCE_PAYMENT_INTENT_NOT_APPROVED'
    );
  }

  const entry = await getFinancialEntry(intent.financialEntryId, transaction);
  const currentHash = computeSnapshotHash(buildEntrySnapshot(entry));
  if (currentHash !== intent.snapshotHash) {
    throw AppError.conflict(
      'O lançamento foi alterado entre a aprovação e a execução desta intenção — execução recusada por segurança.',
      'FINANCE_PAYMENT_INTENT_STALE',
      { expectedHash: intent.snapshotHash, currentHash }
    );
  }

  const settled = await settleFinancialEntry(intent.financialEntryId, actorUserId, transaction);

  const beforeJson = intent.toJSON();
  intent.status = 'EXECUTED';
  intent.executedAt = new Date();
  intent.updatedBy = actorUserId || null;
  await intent.save({ transaction });

  await registrarAuditoria(
    {
      groupId: intent.groupId,
      companyId: intent.companyId,
      actorUserId,
      action: 'finance.payment_intent.execute',
      entityType: 'PaymentIntent',
      entityId: intent.id,
      beforeJson,
      afterJson: intent.toJSON(),
      reason: `Intenção de pagamento executada — lançamento ${settled.id} liquidado conforme o snapshot aprovado.`,
    },
    transaction
  );

  return { intent, entry: settled };
}

async function cancelPaymentIntent(id, reasonText, actorUserId, transaction) {
  const intent = await getPaymentIntent(id, transaction);
  if (['EXECUTED', 'CANCELLED'].includes(intent.status)) {
    throw AppError.conflict(
      `Intenção com status "${intent.status}" não pode ser cancelada.`,
      'FINANCE_PAYMENT_INTENT_INVALID_STATUS'
    );
  }
  const beforeJson = intent.toJSON();
  intent.status = 'CANCELLED';
  intent.cancelledAt = new Date();
  intent.cancelReason = reasonText ? String(reasonText).trim() : null;
  intent.updatedBy = actorUserId || null;
  await intent.save({ transaction });

  await registrarAuditoria(
    {
      groupId: intent.groupId,
      companyId: intent.companyId,
      actorUserId,
      action: 'finance.payment_intent.cancel',
      entityType: 'PaymentIntent',
      entityId: intent.id,
      beforeJson,
      afterJson: intent.toJSON(),
      reason: intent.cancelReason ? `Intenção de pagamento cancelada: ${intent.cancelReason}` : 'Intenção de pagamento cancelada.',
    },
    transaction
  );

  return intent;
}

async function listPaymentIntents(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.financialEntryId) where.financialEntryId = filters.financialEntryId;
  return PaymentIntent.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

module.exports = {
  createPaymentIntent,
  approvePaymentIntent,
  executePaymentIntent,
  cancelPaymentIntent,
  listPaymentIntents,
  getPaymentIntent,
  buildEntrySnapshot,
  computeSnapshotHash,
  STATUSES,
};
