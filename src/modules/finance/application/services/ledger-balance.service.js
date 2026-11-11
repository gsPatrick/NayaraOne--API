'use strict';

/**
 * Saldos calculados a partir do ledger (Guia M4 §2 "cálculo de saldo em decimal exato"; Caderno §6, §10 e §13):
 * saldo em aberto de um lançamento, status derivado do pai e saldo de uma caução (dinheiro de terceiro). Nada é
 * armazenado: o saldo vem sempre das linhas do ledger, somadas em centavos inteiros (domain/ledger-movement.js).
 *
 * Realizado do pai = Σ (baixa filha - estornos que apontam para ela). Assim o estorno de UMA baixa filha devolve o
 * valor ao saldo em aberto (Caderno §6 "Estorno: mantém histórico/status derivado"; verificação 11/11/2026, sonda P4:
 * o pai ficava SETTLED com saldo 0,10 que não se baixava mais).
 */
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const ledger = require('../../infrastructure/repositories/ledger-movement.repository');
const { toCents, fromCents, receivedCentsOf, thirdPartyBalance, realizedCentsOfChildren, derivedParentStatus } = require('../../domain/ledger-movement');

async function getEntryOrFail(id, transaction) {
  const entry = await entries.findById(id, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

/** Centavos realizados pelas baixas filhas do lançamento, já descontados os estornos de cada uma. */
async function realizedChildrenCents(entryId, transaction) {
  const children = await ledger.findSettlementChildren(entryId, transaction);
  const reversed = await ledger.reversedCentsByMovement(children.map((c) => c.id), transaction);
  return { children, realizedCents: realizedCentsOfChildren(children, reversed) };
}

/**
 * computeRemainingAmount — saldo em aberto do lançamento = amount - realizado pelas baixas filhas (baixa menos o
 * estorno de cada uma). Retorna string com 2 casas (mesma precisão do DECIMAL(18,2)).
 */
async function computeRemainingAmount(entryOrId, transaction) {
  const entry = typeof entryOrId === 'string' ? await getEntryOrFail(entryOrId, transaction) : entryOrId;
  const { realizedCents } = await realizedChildrenCents(entry.id, transaction);
  return fromCents(toCents(entry.amount) - realizedCents);
}

/**
 * refreshParentStatus — recalcula o status do pai depois do estorno de uma baixa filha: nada realizado volta a
 * PENDING, parte realizada fica PARTIALLY_SETTLED (o saldo continua baixável) e tudo realizado fica SETTLED. O pai
 * estornado ou cancelado não muda. Grava auditoria quando muda.
 */
async function refreshParentStatus(parentId, actorUserId, transaction, reasonText) {
  const parent = await entries.findByIdForUpdate(parentId, transaction);
  if (!parent || ['REVERSED', 'CANCELLED'].includes(parent.status)) return parent;
  const { realizedCents } = await realizedChildrenCents(parent.id, transaction);
  const status = derivedParentStatus(toCents(parent.amount), realizedCents);
  if (status === parent.status) return parent;
  const beforeJson = parent.toJSON();
  parent.status = status;
  if (status !== 'SETTLED') parent.settledAt = null;
  parent.updatedBy = actorUserId || null;
  await entries.save(parent, transaction);
  await registrarAuditoria(
    {
      groupId: parent.groupId,
      companyId: parent.companyId,
      actorUserId,
      action: 'finance.entry.status_derived',
      entityType: 'FinancialEntry',
      entityId: parent.id,
      beforeJson,
      afterJson: { ...parent.toJSON(), realizedAmount: fromCents(realizedCents), remainingAmount: fromCents(toCents(parent.amount) - realizedCents) },
      reason: `Status do lançamento recalculado pelo ledger depois do estorno de uma baixa: ${beforeJson.status} -> ${status} (realizado ${fromCents(realizedCents)} de ${parent.amount}).${reasonText ? ` ${reasonText}` : ''}`,
    },
    transaction
  );
  return parent;
}

// F04 (conferência Nayara 18/10/2026) — rastreabilidade de caução / dinheiro de terceiros.
// Caderno Financeiro §13: "Movimentação exige vínculo com contrato e titular.
// Devolução/compensação cria evento e ledger próprio." Toda SAÍDA de dinheiro de terceiro
// (PAYABLE com isThirdPartyFunds) aponta para o recebimento de origem e é validada contra ele:
// mesmo contrato, mesmo titular e valor até o saldo ainda não devolvido/compensado daquela origem.
async function receivedAmountCents(origin, transaction) {
  const children = origin.status === 'PARTIALLY_SETTLED' ? await ledger.findSettledChildren(origin.id, transaction) : [];
  return receivedCentsOf(origin, children);
}

async function computeThirdPartyOriginBalance(originOrId, transaction) {
  const origin = typeof originOrId === 'string' ? await entries.findById(originOrId, transaction) : originOrId;
  if (!origin) throw AppError.notFound('Recebimento de origem não encontrado.', 'FINANCE_THIRD_PARTY_ORIGIN_NOT_FOUND');
  const received = await receivedAmountCents(origin, transaction);
  const releases = await entries.findActiveReleases(origin.id, transaction);
  return thirdPartyBalance(origin, received, releases);
}

module.exports = { computeRemainingAmount, computeThirdPartyOriginBalance, refreshParentStatus, realizedChildrenCents };
