'use strict';

/**
 * Estorno controlado (Guia M4 §8 e §15 "POST /finance/ledger/:id/reverse — Estorno controlado"; DEC-003, DEC-057 e DEC-062):
 *   - o pedido de estorno abre um CASO (approval_request do tipo LedgerReversal) com o motivo, o valor e o retrato do movimento original;
 *     quem pede precisa de finance:reverse + MFA recente (rota);
 *   - outra pessoa (financeiro.estorno.aprovador_distinto, padrão ligado) com finance:approve + MFA recente aprova o caso; só então o
 *     estorno é lançado, com `assertCanReverse` e a chave de idempotência literal do Guia `reversal:${original.id}:${approvedCaseId}`;
 *   - aprovar de novo o mesmo caso devolve o estorno já lançado (replay); recusar encerra o caso sem lançar nada.
 * O QUE o estorno lança (valores, filhas, ledger) é do receipt.service (reverseFinancialEntry); aqui está só a autorização.
 */
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { ApprovalRequest, FinancialEntry } = require('../../../../models');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const ledger = require('../../infrastructure/repositories/ledger-movement.repository');
const { buildEntrySnapshot, computeSnapshotHash, toCents, centsText } = require('../../domain/payment-intent');
const { reverseFinancialEntry } = require('./receipt.service');
const { resolvePaymentApprovalPolicy } = require('./payment-approval-policy');
const { KEYS, readBoolean } = require('./payment-approval-settings');
const workflow = require('./approval-workflow');

const TYPE = 'LedgerReversal';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reversalKey = (originalId, caseId) => `reversal:${originalId}:${caseId}`;

/** Guia §8 assertCanReverse (no pedido e de novo na aprovação). */
function assertCanReverse(original, amountCents) {
  if (original.status === 'REVERSED') throw AppError.conflict('Este lançamento já foi estornado.', 'FINANCE_ENTRY_ALREADY_REVERSED');
  if (original.status === 'CANCELLED') throw AppError.conflict('Lançamento cancelado não pode ser estornado.', 'FINANCE_ENTRY_INVALID_STATUS');
  if (amountCents !== null && (amountCents <= 0 || amountCents > toCents(String(original.amount)))) {
    throw AppError.badRequest('O valor do estorno precisa ser maior que zero e no máximo o valor do lançamento.', 'FINANCE_ENTRY_VALIDATION');
  }
}

function caseSnapshot(original, amountCents, reason) {
  return { entry: buildEntrySnapshot(original), amount: amountCents === null ? null : centsText(amountCents), reason };
}

/**
 * requestReversal — abre o caso de estorno. `viaLedger`: o id é de uma linha de finance.ledger (POST /finance/ledger/:id/reverse) e só
 * movimento realizado pode ser estornado.
 */
async function requestReversal(entryId, payload, actorUserId, transaction, { viaLedger = false } = {}) {
  const reason = payload && payload.reason ? String(payload.reason).trim() : '';
  if (!reason) throw AppError.badRequest('Informe o motivo do estorno.', 'FINANCE_REVERSAL_REASON_REQUIRED');
  if (viaLedger) {
    const rows = UUID.test(entryId) ? await ledger.findLedgerRows(entryId, transaction) : [];
    if (rows.length === 0) {
      throw AppError.notFound('Movimento não encontrado no ledger (só movimento realizado pode ser estornado).', 'FINANCE_LEDGER_MOVEMENT_NOT_FOUND');
    }
  }
  const original = await entries.findByIdForUpdate(entryId, transaction);
  if (!original) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const rawAmount = payload.amount;
  const amountCents = rawAmount === undefined || rawAmount === null || rawAmount === '' ? null : toCents(String(rawAmount));
  if (rawAmount !== undefined && rawAmount !== null && rawAmount !== '' && amountCents === null) {
    throw AppError.badRequest('O valor do estorno deve ter até 2 casas decimais.', 'FINANCE_ENTRY_VALIDATION');
  }
  assertCanReverse(original, amountCents);
  const pending = await workflow.findPendingFor(TYPE, original.id, transaction);
  if (pending) throw AppError.conflict('Já existe um pedido de estorno aguardando aprovação para este lançamento.', 'FINANCE_REVERSAL_ALREADY_REQUESTED', { caseId: pending.id });

  const effectiveCents = amountCents === null ? toCents(String(original.amount)) : amountCents;
  const policy = await resolvePaymentApprovalPolicy(original, effectiveCents, { groupId: original.groupId, companyId: original.companyId }, transaction);
  return workflow.createApprovalFor(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      relatedEntityType: TYPE,
      relatedEntityId: original.id,
      // DEC-003: o estorno sempre exige um caso aprovado por uma pessoa; o risco (pelo valor) fica registrado para a fila.
      riskLevel: policy.riskLevel,
      requiredApprovals: 1,
      ruleVersionId: policy.ruleVersionId,
      riskSource: policy.riskSource,
      snapshot: caseSnapshot(original, amountCents, reason),
      amount: centsText(effectiveCents),
      reason,
      payload: { partialAmount: amountCents === null ? null : centsText(amountCents), viaLedger },
    },
    actorUserId,
    transaction
  );
}

async function getCaseForUpdate(caseId, transaction) {
  const reversalCase = await workflow.getApprovalForUpdate(caseId, transaction);
  if (reversalCase.relatedEntityType !== TYPE) throw AppError.notFound('Caso de estorno não encontrado.', 'FINANCE_REVERSAL_CASE_NOT_FOUND');
  return reversalCase;
}

/** Aprova o caso e lança o estorno (uma única vez: a mesma aprovação repetida devolve o estorno existente). */
async function approveReversalCase(caseId, actorUserId, transaction) {
  const reversalCase = await getCaseForUpdate(caseId, transaction);
  const key = reversalKey(reversalCase.relatedEntityId, reversalCase.id);
  if (reversalCase.status === 'APPROVED') {
    const existing = await FinancialEntry.findOne({ where: { idempotencyKey: key }, transaction });
    if (existing) return { case: reversalCase, reversal: existing, replayed: true };
    // Integração M4PG x M4LR: estorno de lançamento quitado em baixas parciais grava uma REVERSAL por baixa (chave de cada baixa), e o
    // previsto não realizado é anulado sem ledger (Caderno §6). A repetição devolve o que a primeira aprovação gravou no caso.
    const feito = reversalCase.payloadJson || {};
    if (feito.reversalEntryId) {
      const gravado = await FinancialEntry.findByPk(feito.reversalEntryId, { transaction });
      if (gravado) return { case: reversalCase, reversal: gravado, replayed: true };
    }
    if (feito.voidedWithoutLedger) return { case: reversalCase, reversal: null, replayed: true };
  }
  const original = await entries.findByIdForUpdate(reversalCase.relatedEntityId, transaction);
  if (!original) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const partial = reversalCase.payloadJson && reversalCase.payloadJson.partialAmount;
  if (reversalCase.status === 'PENDING' && computeSnapshotHash(caseSnapshot(original, partial ? toCents(partial) : null, reversalCase.reason)) !== reversalCase.snapshotHash) {
    await workflow.markStale(reversalCase, 'O lançamento mudou depois do pedido de estorno.', actorUserId, transaction);
    return { case: reversalCase, stale: true };
  }
  assertCanReverse(original, partial ? toCents(partial) : null);
  const distinct = await readBoolean(KEYS.reversalDistinctApprover, { groupId: original.groupId, companyId: original.companyId }, transaction);
  await workflow.recordDecision(reversalCase, { decision: 'APPROVED', approverUserId: actorUserId, requireMfa: true, allowRequester: !distinct }, transaction);

  const caseBefore = reversalCase.toJSON();
  const { original: after, reversal } = await reverseFinancialEntry(original.id, reversalCase.reason, actorUserId, transaction, {
    ...(partial ? { amount: partial } : {}),
    idempotencyKey: key,
    approvedCaseId: reversalCase.id,
    // M4LR (Caderno §6): o pedido de estorno da tela anula o previsto não realizado, sem movimento no ledger.
    voidNotRealized: true,
  });
  reversalCase.payloadJson = {
    ...(reversalCase.payloadJson || {}), reversalEntryId: reversal ? reversal.id : null, ...(reversal ? {} : { voidedWithoutLedger: true }), approvedByUserId: actorUserId,
  };
  await reversalCase.save({ transaction });
  await registrarAuditoria(
    {
      groupId: reversalCase.groupId, companyId: reversalCase.companyId, actorUserId, action: 'finance.reversal_case.execute', entityType: 'ApprovalRequest', entityId: reversalCase.id,
      beforeJson: caseBefore,
      afterJson: { case: reversalCase.toJSON(), reversalEntryId: reversal ? reversal.id : null, idempotencyKey: key },
      reason: `Estorno lançado pelo caso aprovado (pedido de ${reversalCase.requestedByUserId}, aprovado por ${actorUserId}): ${reversalCase.reason}`,
    },
    transaction
  );
  return { case: reversalCase, original: after, reversal };
}

async function rejectReversalCase(caseId, payload, actorUserId, transaction) {
  const reversalCase = await getCaseForUpdate(caseId, transaction);
  const distinct = await readBoolean(KEYS.reversalDistinctApprover, { groupId: reversalCase.groupId, companyId: reversalCase.companyId }, transaction);
  await workflow.recordDecision(reversalCase, { decision: 'REJECTED', approverUserId: actorUserId, allowRequester: !distinct }, transaction);
  if (payload && payload.reason) {
    reversalCase.payloadJson = { ...(reversalCase.payloadJson || {}), rejectionReason: String(payload.reason).trim() };
    await reversalCase.save({ transaction });
  }
  return { case: reversalCase };
}

async function listReversalCases(transaction, filters = {}) {
  const where = { relatedEntityType: TYPE };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.entryId) where.relatedEntityId = filters.entryId;
  const cases = await ApprovalRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
  const ids = [...new Set(cases.map((c) => c.relatedEntityId))];
  const originals = ids.length ? await FinancialEntry.findAll({ attributes: ['id', 'description', 'amount', 'status', 'nature'], where: { id: ids }, transaction }) : [];
  const byId = new Map(originals.map((o) => [o.id, o]));
  return cases.map((c) => ({ ...c.toJSON(), original: byId.get(c.relatedEntityId) ? byId.get(c.relatedEntityId).toJSON() : null }));
}

module.exports = { requestReversal, approveReversalCase, rejectReversalCase, listReversalCases, assertCanReverse, reversalKey, TYPE };
