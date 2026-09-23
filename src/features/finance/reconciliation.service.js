'use strict';

const { randomUUID } = require('node:crypto');

const { Reconciliation, FinancialEntry, BankTransaction } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishReconciliationMatched } = require('./financeEvents.service');

// Motor de conciliação — casa um finance.financial_entries (lançamento) com um
// finance.bank_transactions (linha real de extrato). Regras duras:
//   - valores devem bater (mesmo módulo, tolerância zero — nenhuma "reconciliação aproximada"
//     está prevista no schema/documento);
//   - nem o lançamento nem a transação podem já estar conciliados com outra coisa (1:1).

async function assertNotAlreadyReconciled(financialEntryId, bankTransactionId, transaction) {
  const existingForEntry = await Reconciliation.findOne({ where: { financialEntryId }, transaction });
  if (existingForEntry) {
    throw AppError.conflict('Este lançamento financeiro já está conciliado com outra transação.', 'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED');
  }
  const existingForTransaction = await Reconciliation.findOne({ where: { bankTransactionId }, transaction });
  if (existingForTransaction) {
    throw AppError.conflict('Esta transação de extrato já está conciliada com outro lançamento.', 'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED');
  }
}

async function matchReconciliation(payload, actorUserId, transaction) {
  const { groupId, companyId, financialEntryId, bankTransactionId } = payload;
  if (!groupId || !companyId || !financialEntryId || !bankTransactionId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "financialEntryId" e "bankTransactionId" são obrigatórios.',
      'FINANCE_RECONCILIATION_VALIDATION'
    );
  }

  // FIX (homologação 23/09/2026 — auditoria adversarial, corrida real de verdade validada):
  // não existe (e não dá pra existir sem redesenhar o schema — ver comentário em
  // matchReconciliationGroup sobre por que um financial_entry_id/bank_transaction_id pode
  // legitimamente se repetir em mais de uma linha dentro do MESMO grupo N:M) uma constraint
  // única simples que trave "entry/transaction só pode ser conciliado uma vez" no banco. Sem
  // isso, duas chamadas concorrentes de matchReconciliation para o MESMO entry/transaction
  // liam "ainda não conciliado" ao mesmo tempo (SELECT-then-INSERT clássico) e as duas
  // passavam. `FOR UPDATE` na leitura do entry/transaction serializa: a segunda transação
  // BLOQUEIA até a primeira commitar, e só então reavalia assertNotAlreadyReconciled — que
  // nesse ponto já enxerga a Reconciliation da primeira e barra corretamente.
  const entry = await FinancialEntry.findByPk(financialEntryId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const bankTransaction = await BankTransaction.findByPk(bankTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!bankTransaction) throw AppError.notFound('Transação bancária não encontrada.', 'FINANCE_BANK_TRANSACTION_NOT_FOUND');

  if (Number(entry.amount) !== Math.abs(Number(bankTransaction.amount))) {
    throw AppError.conflict(
      `Valores não batem: lançamento ${entry.amount} vs. transação ${bankTransaction.amount}. Conciliação bloqueada.`,
      'FINANCE_RECONCILIATION_AMOUNT_MISMATCH'
    );
  }

  await assertNotAlreadyReconciled(financialEntryId, bankTransactionId, transaction);

  const reconciliation = await Reconciliation.create(
    {
      groupId,
      companyId,
      financialEntryId,
      bankTransactionId,
      matchedAt: new Date(),
      matchedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishReconciliationMatched(reconciliation, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.reconciliation.match',
      entityType: 'Reconciliation',
      entityId: reconciliation.id,
      afterJson: reconciliation.toJSON(),
      reason: `Lançamento financeiro conciliado com transação de extrato (valor ${entry.amount}).`,
    },
    transaction
  );

  return reconciliation;
}

// --- M4-13: conciliação N:N -----------------------------------------------------------------
//
// MODELAGEM (decisão documentada): não criamos tabela nova. Reaproveitamos `reconciliations`
// (1 linha = 1 par lançamento↔transação, com as FKs NOT NULL que já existem) e amarramos todas
// as linhas de um mesmo casamento por um `match_group_id` compartilhado (migration 000159).
// As linhas geradas formam uma ESTRELA, não o produto cartesiano: cada lançamento é ligado à
// PRIMEIRA transação, e cada transação extra é ligada ao PRIMEIRO lançamento. São
// N + M - 1 linhas, toda entidade do grupo aparece pelo menos uma vez (o que mantém
// `assertNotAlreadyReconciled` funcionando sem nenhuma adaptação de leitura) e não se inventa
// um vínculo par-a-par que financeiramente não existe — o vínculo real é o GRUPO.
//
// Tolerância ZERO no valor, igual ao 1:1: Σ(lançamentos) precisa bater exatamente com
// Σ(|transações|). A soma é feita em CENTAVOS inteiros — somar DECIMAL como float
// introduziria erro de arredondamento justamente onde a regra é "bater no centavo".

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function uniqueList(ids, label) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (list.length === 0) {
    throw AppError.badRequest(`O campo "${label}" deve conter pelo menos um id.`, 'FINANCE_RECONCILIATION_VALIDATION');
  }
  if (new Set(list).size !== list.length) {
    throw AppError.badRequest(`O campo "${label}" tem ids repetidos.`, 'FINANCE_RECONCILIATION_VALIDATION');
  }
  return list;
}

async function matchReconciliationGroup(payload, actorUserId, transaction) {
  const { groupId, companyId, financialEntryIds, bankTransactionIds } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_RECONCILIATION_VALIDATION');
  }
  const entryIds = uniqueList(financialEntryIds, 'financialEntryIds');
  const txIds = uniqueList(bankTransactionIds, 'bankTransactionIds');

  // FIX (homologação 23/09/2026 — mesma corrida de matchReconciliation acima, aplicada ao
  // caminho N:M): FOR UPDATE trava cada entry/transaction do grupo antes de checar se já foi
  // conciliado, serializando tentativas concorrentes sobre o mesmo item.
  const entries = [];
  for (const entryId of entryIds) {
    const entry = await FinancialEntry.findByPk(entryId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!entry) throw AppError.notFound(`Lançamento financeiro ${entryId} não encontrado.`, 'FINANCE_ENTRY_NOT_FOUND');
    entries.push(entry);
  }
  const bankTransactions = [];
  for (const txId of txIds) {
    const bankTransaction = await BankTransaction.findByPk(txId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!bankTransaction) throw AppError.notFound(`Transação bancária ${txId} não encontrada.`, 'FINANCE_BANK_TRANSACTION_NOT_FOUND');
    bankTransactions.push(bankTransaction);
  }

  const entriesCents = entries.reduce((acc, e) => acc + toCents(e.amount), 0);
  const txCents = bankTransactions.reduce((acc, t) => acc + Math.abs(toCents(t.amount)), 0);
  if (entriesCents !== txCents) {
    throw AppError.conflict(
      `Valores não batem: soma dos lançamentos ${(entriesCents / 100).toFixed(2)} vs. soma das transações ` +
        `${(txCents / 100).toFixed(2)}. Conciliação em grupo bloqueada (tolerância zero).`,
      'FINANCE_RECONCILIATION_AMOUNT_MISMATCH'
    );
  }

  // Cada entry/transaction do grupo precisa estar livre — mesma regra do 1:1, aplicada item a item.
  for (const entry of entries) {
    const existing = await Reconciliation.findOne({ where: { financialEntryId: entry.id }, transaction });
    if (existing) {
      throw AppError.conflict(
        `O lançamento ${entry.id} já está conciliado com outra transação.`,
        'FINANCE_RECONCILIATION_ENTRY_ALREADY_MATCHED'
      );
    }
  }
  for (const bankTransaction of bankTransactions) {
    const existing = await Reconciliation.findOne({ where: { bankTransactionId: bankTransaction.id }, transaction });
    if (existing) {
      throw AppError.conflict(
        `A transação de extrato ${bankTransaction.id} já está conciliada com outro lançamento.`,
        'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED'
      );
    }
  }

  const matchGroupId = randomUUID();
  const matchedAt = new Date();
  const pairs = [
    ...entries.map((entry) => ({ financialEntryId: entry.id, bankTransactionId: bankTransactions[0].id })),
    ...bankTransactions.slice(1).map((bankTransaction) => ({
      financialEntryId: entries[0].id,
      bankTransactionId: bankTransaction.id,
    })),
  ];

  const reconciliations = [];
  for (const pair of pairs) {
    const reconciliation = await Reconciliation.create(
      {
        groupId,
        companyId,
        financialEntryId: pair.financialEntryId,
        bankTransactionId: pair.bankTransactionId,
        matchGroupId,
        matchedAt,
        matchedByUserId: actorUserId || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    await publishReconciliationMatched(reconciliation, transaction);
    reconciliations.push(reconciliation);
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.reconciliation.match_group',
      entityType: 'Reconciliation',
      entityId: matchGroupId,
      afterJson: {
        matchGroupId,
        financialEntryIds: entryIds,
        bankTransactionIds: txIds,
        totalAmount: (entriesCents / 100).toFixed(2),
        reconciliationIds: reconciliations.map((r) => r.id),
      },
      reason:
        `Conciliação em grupo (${entryIds.length} lançamento(s) x ${txIds.length} transação(ões)) ` +
        `no valor total de ${(entriesCents / 100).toFixed(2)}.`,
    },
    transaction
  );

  return { matchGroupId, reconciliations, totalAmount: (entriesCents / 100).toFixed(2) };
}

async function listReconciliations(transaction, filters = {}) {
  const where = {};
  if (filters.financialEntryId) where.financialEntryId = filters.financialEntryId;
  if (filters.bankTransactionId) where.bankTransactionId = filters.bankTransactionId;
  if (filters.matchGroupId) where.matchGroupId = filters.matchGroupId;
  return Reconciliation.findAll({ where, order: [['matched_at', 'DESC']], transaction });
}

module.exports = { matchReconciliation, matchReconciliationGroup, listReconciliations };
