'use strict';

/**
 * Fila de conciliação e confirmação humana de match — Guia M4 §15 "GET /finance/reconciliation/pending
 * — Fila" e "POST /finance/reconciliation/:id/confirm — Confirmar match"; Caderno §11:
 *   Exato -> auto confirmado; Forte -> auto ou revisão conforme regra; Provável -> sugestão, humano
 *   confirma; Ambíguo -> nunca auto conciliar; Sem correspondência -> fila de pendência.
 * A fila reúne as transações de extrato ainda sem conciliação e as pendências de classificação de
 * excedente (§10). A confirmação é sempre um ato humano sobre um candidato que o motor considera
 * elegível (mesmo valor, sentido e conta); quando a classe final é Ambíguo ou Provável, a pessoa
 * precisa escolher o lançamento (nunca é escolhido sozinho).
 */
const { BankTransaction, Reconciliation } = require('../../models');
const AppError = require('../../utils/AppError');
const reconciliationService = require('./reconciliation.service');
const { listClassificationPendings } = require('./financialEntries.service');

const { MATCH_CLASSES } = reconciliationService;

function toCents(value) {
  return Math.round(Math.abs(Number(value)) * 100);
}

async function listPendingQueue(transaction, { includeSuggestions = false } = {}) {
  const [bankTransactions, reconciliations, classification] = await Promise.all([
    BankTransaction.findAll({ order: [['transaction_date', 'DESC']], transaction }),
    Reconciliation.findAll({ attributes: ['bankTransactionId'], transaction }),
    listClassificationPendings(transaction, { status: 'PENDING' }),
  ]);
  const reconciled = new Set(reconciliations.map((r) => r.bankTransactionId));
  const unmatched = bankTransactions.filter((b) => !reconciled.has(b.id));
  const items = [];
  for (const b of unmatched) {
    const item = { ...b.toJSON(), pendingType: 'BANK_TRANSACTION_UNMATCHED' };
    if (includeSuggestions) {
      const s = await reconciliationService.suggestReconciliationMatches(b.id, transaction);
      item.suggestion = { finalClass: s.finalClass, candidates: s.candidates.length, topCandidate: s.candidates[0] || null };
    }
    items.push(item);
  }
  return {
    bankTransactions: items,
    classificationPendings: classification,
    totals: {
      bankTransactions: items.length,
      bankTransactionsAmount: (items.reduce((acc, b) => acc + toCents(b.amount), 0) / 100).toFixed(2),
      classificationPendings: classification.length,
      classificationPendingsAmount: (classification.reduce((acc, c) => acc + toCents(c.amount), 0) / 100).toFixed(2),
    },
  };
}

/**
 * confirmMatch — :id é a transação de extrato. `financialEntryId` (opcional só quando a classe
 * final é Exato ou Forte, com um único candidato no topo) escolhe o lançamento. O lançamento
 * precisa estar entre os candidatos elegíveis do motor; a conciliação em si é a mesma de
 * POST /finance/reconciliations (valor, sentido, conta, sem duplicidade, auditoria, evento).
 */
async function confirmMatch({ groupId, companyId, bankTransactionId, financialEntryId }, actorUserId, transaction) {
  const suggestion = await reconciliationService.suggestReconciliationMatches(bankTransactionId, transaction);
  if (suggestion.alreadyReconciled) {
    throw AppError.conflict('Esta transação de extrato já está conciliada com outro lançamento.', 'FINANCE_RECONCILIATION_TRANSACTION_ALREADY_MATCHED');
  }
  if (suggestion.finalClass === MATCH_CLASSES.NO_MATCH || suggestion.candidates.length === 0) {
    throw AppError.conflict('Nenhum lançamento elegível para esta transação (sem correspondência): ela fica na fila de pendência.', 'FINANCE_RECONCILIATION_NO_CANDIDATE');
  }
  let chosen = financialEntryId || null;
  if (!chosen) {
    if (suggestion.finalClass === MATCH_CLASSES.AMBIGUOUS || suggestion.finalClass === MATCH_CLASSES.PROBABLE) {
      throw AppError.conflict(
        'Há mais de uma possibilidade ou a correspondência é só provável: escolha o lançamento (financialEntryId) para confirmar. Este caso nunca é conciliado sozinho.',
        'FINANCE_RECONCILIATION_CHOICE_REQUIRED',
        { finalClass: suggestion.finalClass, candidates: suggestion.candidates.map((c) => c.financialEntryId) }
      );
    }
    chosen = suggestion.candidates[0].financialEntryId;
  }
  const candidate = suggestion.candidates.find((c) => c.financialEntryId === chosen);
  if (!candidate) {
    throw AppError.conflict('O lançamento escolhido não é um candidato elegível para esta transação (valor, sentido ou conta não batem).', 'FINANCE_RECONCILIATION_NOT_A_CANDIDATE');
  }
  const reconciliation = await reconciliationService.matchReconciliation(
    { groupId, companyId, financialEntryId: chosen, bankTransactionId },
    actorUserId,
    transaction
  );
  return {
    reconciliation,
    finalClass: suggestion.finalClass,
    confirmedCandidate: { financialEntryId: chosen, score: candidate.score, class: candidate.class, reasons: candidate.reasons },
    method: 'HUMAN_CONFIRMED',
  };
}

module.exports = { listPendingQueue, confirmMatch };
