'use strict';

const { FinancialEntry } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { assertBankAccountEligibleForPayment, assertNoDuplicatePayment } = require('./financeAntifraud.service');
const { publishFinancialEntryCreated, publishFinancialEntrySettled, publishFinancialEntryReversed } = require('./financeEvents.service');

// finance.financial_entries É o ledger (não existe uma tabela "finance.ledger" separada — ver
// nota em financeAntifraud.service.js e o relatório de schema real). Regras duras
// (01_ARQUITETURA_E_INVARIANTES.md, FIN-003/FIN-010): "Ledger imutável... correção é sempre
// por estorno/lançamento compensatório" — por isso este service NUNCA dá UPDATE em `amount`
// de um lançamento já SETTLED, e `reverseEntry` cria um novo registro em vez de apagar/alterar
// o original.

const ENTRY_TYPES = ['DEBIT', 'CREDIT'];
const NATURES = ['PAYABLE', 'RECEIVABLE', 'TRANSFER', 'ADJUSTMENT'];
const STATUSES = ['PENDING', 'SETTLED', 'REVERSED', 'CANCELLED'];

function assertPositiveAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw AppError.badRequest('O campo "amount" deve ser um número positivo (moeda em numeric/decimal — FIN-008).', 'FINANCE_ENTRY_VALIDATION');
  }
}

/**
 * createFinancialEntry — cria uma obrigação/direito (conta a pagar/receber) em status PENDING.
 * `idempotencyKey`, quando informada, impede duplicidade (ex.: reprocessar o mesmo import não
 * cria dois lançamentos — FIN-004).
 */
async function createFinancialEntry(payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    bankAccountId,
    costCenterId,
    resultCenterId,
    contractId,
    entryType,
    nature,
    amount,
    dueAt,
    idempotencyKey,
  } = payload;

  if (!groupId || !companyId || !entryType || !nature || amount === undefined || amount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "entryType", "nature" e "amount" são obrigatórios.',
      'FINANCE_ENTRY_VALIDATION'
    );
  }
  const normalizedType = String(entryType).toUpperCase();
  const normalizedNature = String(nature).toUpperCase();
  if (!ENTRY_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "entryType" deve ser um de: ${ENTRY_TYPES.join(', ')}.`, 'FINANCE_ENTRY_VALIDATION');
  }
  if (!NATURES.includes(normalizedNature)) {
    throw AppError.badRequest(`O campo "nature" deve ser um de: ${NATURES.join(', ')}.`, 'FINANCE_ENTRY_VALIDATION');
  }
  assertPositiveAmount(amount);

  await assertNoDuplicatePayment(FinancialEntry, idempotencyKey, transaction);

  const entry = await FinancialEntry.create(
    {
      groupId,
      companyId,
      bankAccountId: bankAccountId || null,
      costCenterId: costCenterId || null,
      resultCenterId: resultCenterId || null,
      contractId: contractId || null,
      entryType: normalizedType,
      nature: normalizedNature,
      amount,
      dueAt: dueAt || null,
      settledAt: null,
      status: 'PENDING',
      idempotencyKey: idempotencyKey || null,
      reversalOfEntryId: null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishFinancialEntryCreated(entry, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.entry.create',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      afterJson: entry.toJSON(),
      reason: `Lançamento ${normalizedNature === 'PAYABLE' ? 'a pagar' : normalizedNature === 'RECEIVABLE' ? 'a receber' : normalizedNature.toLowerCase()} de ${amount} criado.`,
    },
    transaction
  );

  return entry;
}

async function listFinancialEntries(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.nature) where.nature = String(filters.nature).toUpperCase();
  if (filters.bankAccountId) where.bankAccountId = filters.bankAccountId;
  if (filters.costCenterId) where.costCenterId = filters.costCenterId;
  return FinancialEntry.findAll({ where, order: [['due_at', 'ASC']], transaction });
}

async function getFinancialEntry(id, transaction) {
  const entry = await FinancialEntry.findByPk(id, { transaction });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

/**
 * updateFinancialEntry — só permite editar campos "de agenda" (vencimento, centro de custo/
 * resultado, conta bancária) enquanto o lançamento estiver PENDING. Uma vez SETTLED/REVERSED,
 * o registro é histórico — qualquer correção de valor precisa passar por `reverseEntry`.
 */
async function updateFinancialEntry(id, payload, actorUserId, transaction) {
  const entry = await getFinancialEntry(id, transaction);
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(
      `Lançamento com status "${entry.status}" não pode mais ser editado — ledger imutável (FIN-003). Use estorno.`,
      'FINANCE_ENTRY_IMMUTABLE'
    );
  }
  const beforeJson = entry.toJSON();
  const { bankAccountId, costCenterId, resultCenterId, dueAt } = payload;
  if (bankAccountId !== undefined) entry.bankAccountId = bankAccountId;
  if (costCenterId !== undefined) entry.costCenterId = costCenterId;
  if (resultCenterId !== undefined) entry.resultCenterId = resultCenterId;
  if (dueAt !== undefined) entry.dueAt = dueAt;
  entry.updatedBy = actorUserId || null;
  await entry.save({ transaction });

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.update',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: 'Lançamento financeiro atualizado (agenda).',
    },
    transaction
  );

  return entry;
}

/**
 * settleFinancialEntry — baixa/liquida o lançamento (marca como pago/recebido). Se houver
 * `bankAccountId`, valida elegibilidade antifraude (cooldown/bloqueio) antes de liquidar.
 */
async function settleFinancialEntry(id, actorUserId, transaction) {
  const entry = await getFinancialEntry(id, transaction);
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível liquidar um lançamento PENDING (atual: "${entry.status}").`, 'FINANCE_ENTRY_INVALID_STATUS');
  }
  const beforeJson = entry.toJSON();

  if (entry.bankAccountId) {
    await assertBankAccountEligibleForPayment(entry.bankAccountId, transaction);
  }

  entry.status = 'SETTLED';
  entry.settledAt = new Date();
  entry.updatedBy = actorUserId || null;
  await entry.save({ transaction });

  await publishFinancialEntrySettled(entry, transaction);

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settle',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: `Lançamento de ${entry.amount} liquidado.`,
    },
    transaction
  );

  return entry;
}

/**
 * reverseEntry — ESTORNO. Nunca apaga nem edita o valor do lançamento original (FIN-010):
 * marca o original como REVERSED e cria um novo lançamento compensatório (`entryType`
 * invertido, mesmo `amount`) apontando de volta via `reversalOfEntryId`.
 */
async function reverseFinancialEntry(id, reasonText, actorUserId, transaction) {
  const original = await getFinancialEntry(id, transaction);
  if (original.status === 'REVERSED') {
    throw AppError.conflict('Este lançamento já foi estornado.', 'FINANCE_ENTRY_ALREADY_REVERSED');
  }
  if (original.status === 'CANCELLED') {
    throw AppError.conflict('Lançamento cancelado não pode ser estornado.', 'FINANCE_ENTRY_INVALID_STATUS');
  }
  const beforeJson = original.toJSON();

  const compensatingType = original.entryType === 'DEBIT' ? 'CREDIT' : 'DEBIT';
  const reversal = await FinancialEntry.create(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      bankAccountId: original.bankAccountId,
      costCenterId: original.costCenterId,
      resultCenterId: original.resultCenterId,
      contractId: original.contractId,
      entryType: compensatingType,
      nature: 'ADJUSTMENT',
      amount: original.amount,
      dueAt: null,
      settledAt: new Date(),
      status: 'SETTLED',
      idempotencyKey: null,
      reversalOfEntryId: original.id,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  original.status = 'REVERSED';
  original.updatedBy = actorUserId || null;
  await original.save({ transaction });

  await publishFinancialEntryReversed(original, reversal, transaction);

  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'finance.entry.reverse',
      entityType: 'FinancialEntry',
      entityId: original.id,
      beforeJson,
      afterJson: { original: original.toJSON(), reversalEntryId: reversal.id },
      reason: reasonText ? `Lançamento estornado: ${reasonText}` : 'Lançamento estornado.',
    },
    transaction
  );

  return { original, reversal };
}

module.exports = {
  createFinancialEntry,
  listFinancialEntries,
  getFinancialEntry,
  updateFinancialEntry,
  settleFinancialEntry,
  reverseFinancialEntry,
  ENTRY_TYPES,
  NATURES,
  STATUSES,
};
