'use strict';

/**
 * Domínio do movimento de ledger (Guia M4 §2; Caderno §2 FIN-003/FIN-008/FIN-010, §10 e §13): saldo em
 * centavos inteiros (decimal exato), divisão do recebimento entre o saldo e o excedente, saldo da caução e a
 * montagem dos movimentos realizados (baixa parcial, excedente em pendência de classificação e estorno).
 *
 * MODELAGEM (M4-06): o ledger é append-only e imutável — o `amount` do lançamento original NUNCA é alterado por
 * uma baixa parcial. Cada baixa vira um NOVO lançamento SETTLED (mesmo entryType/nature/conta do pai) com o valor
 * parcial, ligado ao original por `parentEntryId`. O ORIGINAL só muda de STATUS:
 *   PENDING -> PARTIALLY_SETTLED (ainda há saldo) -> SETTLED (soma das baixas = amount).
 * O saldo restante é CALCULADO, nunca armazenado. Toda a aritmética é feita em CENTAVOS inteiros: DECIMAL(18,2)
 * em ponto flutuante daria erro de arredondamento (0.1 + 0.2 !== 0.3).
 */
const { compensatingEntryType } = require('./financial-entry');

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

// Marco 7 "reval" (16/10/2026): a description da baixa parcial usa valor em pt-BR e a descrição de negócio do original, nunca o UUID.
function toBRLDisplay(decimalString) {
  return Number(decimalString).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatBRLText(cents) {
  return (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function sumCents(rows) {
  return rows.reduce((acc, row) => acc + toCents(row.amount), 0);
}

/** Saldo em aberto = amount - Σ(baixas filhas SETTLED), string com 2 casas (mesma precisão do DECIMAL(18,2)). */
function remainingAmount(amount, settledChildren) {
  return fromCents(toCents(amount) - sumCents(settledChildren));
}

// Tipo do movimento gravado na linha (coluna movement_kind, migration 20260101010520): a baixa parcial, o complemento
// (quitação do saldo de um lançamento que já tem movimento — Caderno §6 "pagamento parcial, estorno, complemento"), o
// excedente em pendência de classificação (§10) e o estorno (REVERSAL apontando o movimento original, §6/Guia §8).
const MOVEMENT_KINDS = Object.freeze({ PARTIAL: 'PARTIAL', COMPLEMENT: 'COMPLEMENT', EXCESS: 'EXCESS', REVERSAL: 'REVERSAL' });
// Movimentos que baixam o saldo do lançamento pai (o excedente não baixa: é dinheiro a mais, §10).
const SETTLEMENT_CHILD_KINDS = Object.freeze([MOVEMENT_KINDS.PARTIAL, MOVEMENT_KINDS.COMPLEMENT]);

/**
 * Realizado de cada baixa filha = valor da baixa - estornos que apontam para ela (estorno total ou parcial).
 * `children`: [{ id, amount }]; `reversedCentsById`: Map id -> centavos já estornados.
 */
function realizedCentsOfChildren(children, reversedCentsById) {
  return children.reduce((acc, child) => acc + Math.max(0, toCents(child.amount) - (reversedCentsById.get(child.id) || 0)), 0);
}

/** Status derivado do pai (Caderno §6 "Estorno: mantém histórico/status derivado"): nada realizado, parte ou tudo. */
function derivedParentStatus(amountCents, realizedCents) {
  if (realizedCents <= 0) return 'PENDING';
  return realizedCents >= amountCents ? 'SETTLED' : 'PARTIALLY_SETTLED';
}

/** Chave de idempotência do estorno (Guia §8: `reversal:${original.id}:${approvedCaseId}`). */
function reversalIdempotencyKey(movementId, caseRef) {
  return `reversal:${movementId}:${caseRef}`;
}

/** Recebimento é sempre aceito: o que passa do saldo vira excedente (pendência de classificação, §10). */
function splitReceipt(partialCents, remainingCents) {
  const appliedCents = Math.min(partialCents, remainingCents);
  return { appliedCents, excessCents: partialCents - appliedCents };
}

function statusAfterPartialSettlement(newRemainingCents) {
  return newRemainingCents === 0 ? 'SETTLED' : 'PARTIALLY_SETTLED';
}

/** Quanto da caução de origem já foi recebido, em centavos (integral ou soma das baixas filhas). */
function receivedCentsOf(origin, settledChildren) {
  if (origin.status === 'SETTLED') return toCents(origin.amount);
  if (origin.status === 'PARTIALLY_SETTLED') return sumCents(settledChildren);
  return 0;
}

/** Saldo da caução (F04, Caderno §13): recebido, já devolvido/compensado e disponível. */
function thirdPartyBalance(origin, receivedCents, releases) {
  const releasedCents = sumCents(releases);
  return {
    originEntryId: origin.id,
    contractId: origin.contractId,
    holderPersonId: origin.thirdPartyHolderPersonId,
    received: fromCents(receivedCents),
    released: fromCents(releasedCents),
    available: fromCents(receivedCents - releasedCents),
    releases: releases.map((release) => ({ id: release.id, amount: release.amount, status: release.status, description: release.description })),
  };
}

/**
 * Baixa parcial: NOVO lançamento SETTLED filho do original, com o valor aplicado.
 * @param {any} entry
 * @param {{ appliedCents: number, settledAt?: any, idempotencyKey?: string|null, settlementInfo?: any, actorUserId?: string|null, movementKind?: string }} args
 */
function buildPartialSettlementValues(entry, { appliedCents, settledAt, idempotencyKey, settlementInfo, actorUserId, movementKind = MOVEMENT_KINDS.PARTIAL }) {
  return {
    groupId: entry.groupId,
    companyId: entry.companyId,
    bankAccountId: entry.bankAccountId,
    costCenterId: entry.costCenterId,
    resultCenterId: entry.resultCenterId,
    contractId: entry.contractId,
    entryType: entry.entryType,
    nature: entry.nature,
    amount: fromCents(appliedCents),
    description: `${movementKind === MOVEMENT_KINDS.COMPLEMENT ? 'Complemento (quitação do saldo)' : 'Baixa parcial'} de ${toBRLDisplay(fromCents(appliedCents))} — ${entry.description || 'lançamento financeiro'}`,
    dueAt: entry.dueAt,
    // A baixa parcial pertence à MESMA competência do lançamento original (a obrigação é a
    // mesma; o que mudou foi só o momento do caixa).
    competenceMonth: entry.competenceMonth,
    settledAt,
    status: 'SETTLED',
    idempotencyKey,
    reversalOfEntryId: null,
    parentEntryId: entry.id,
    movementKind,
    settlementMethod: settlementInfo ? settlementInfo.method : null,
    settlementEvidenceFileId: settlementInfo ? settlementInfo.evidenceFileId : null,
    settlementReason: settlementInfo ? settlementInfo.reason : null,
    // D3 (revisão independente, provado): a baixa parcial de uma caução nascia com
    // isThirdPartyFunds=false — relatórios que somam receita própria (isThirdPartyFunds:false)
    // passavam a contar caução como receita. A filha herda a marca e o vínculo do pai.
    isThirdPartyFunds: Boolean(entry.isThirdPartyFunds),
    thirdPartyReference: entry.thirdPartyReference || null,
    thirdPartyOriginEntryId: entry.thirdPartyOriginEntryId || null,
    thirdPartyHolderPersonId: entry.thirdPartyHolderPersonId || null,
    thirdPartyReleaseType: entry.thirdPartyReleaseType || null,
    // M6-97 (verificação independente do Marco 6): a baixa parcial carrega a obra do original, como o estorno já fazia.
    constructionProjectId: entry.constructionProjectId || null,
    createdBy: actorUserId || null,
    updatedBy: actorUserId || null,
  };
}

/** Excedente do recebimento: filho PENDING_CLASSIFICATION em aberto — nunca receita automática (§10). */
function buildExcessPendingValues(entry, { excessCents, idempotencyKey, actorUserId }) {
  return {
    groupId: entry.groupId,
    companyId: entry.companyId,
    bankAccountId: entry.bankAccountId,
    costCenterId: null,
    resultCenterId: null,
    contractId: entry.contractId,
    entryType: entry.entryType,
    nature: 'PENDING_CLASSIFICATION',
    amount: fromCents(excessCents),
    description:
      // Texto para o usuário (sem UUID): o vínculo com a origem fica em parentEntryId.
      `Valor recebido a mais (${formatBRLText(excessCents)}) em "${entry.description || 'lançamento'}" ` +
      '— aguardando classificação manual.',
    dueAt: null,
    competenceMonth: entry.competenceMonth,
    settledAt: null,
    status: 'PENDING',
    idempotencyKey: idempotencyKey ? `${idempotencyKey}:excedente` : null,
    reversalOfEntryId: null,
    parentEntryId: entry.id,
    movementKind: MOVEMENT_KINDS.EXCESS,
    createdBy: actorUserId || null,
    updatedBy: actorUserId || null,
  };
}

/**
 * Estorno (FIN-010; Guia §8 reverseLedger): movimento REVERSAL com a direção invertida, apontando o movimento original
 * realizado, na conta do original e com chave `reversal:<movimento>:<caso>`. `amountCents` é o valor estornado (total
 * = o que ainda não foi estornado do movimento; parcial = o informado).
 */
function buildReversalValues(original, { isPartial, amountCents, idempotencyKey, actorUserId }) {
  return {
    groupId: original.groupId,
    companyId: original.companyId,
    bankAccountId: original.bankAccountId,
    costCenterId: original.costCenterId,
    resultCenterId: original.resultCenterId,
    contractId: original.contractId,
    entryType: compensatingEntryType(original.entryType),
    nature: 'ADJUSTMENT',
    amount: fromCents(amountCents),
    description: isPartial ? `Estorno parcial de ${toBRLDisplay(fromCents(amountCents))} — ${original.description || 'lançamento financeiro'}` : null,
    dueAt: null,
    // O estorno pertence à mesma competência do lançamento estornado.
    competenceMonth: original.competenceMonth,
    settledAt: new Date(),
    status: 'SETTLED',
    idempotencyKey,
    reversalOfEntryId: original.id,
    movementKind: MOVEMENT_KINDS.REVERSAL,
    // As dimensões contábeis do original acompanham o compensatório (plano de contas e obra).
    chartOfAccountId: original.chartOfAccountId || null,
    chartOfAccountVersionId: original.chartOfAccountVersionId || null,
    constructionProjectId: original.constructionProjectId || null,
    createdBy: actorUserId || null,
    updatedBy: actorUserId || null,
  };
}

module.exports = {
  toCents,
  fromCents,
  toBRLDisplay,
  formatBRLText,
  sumCents,
  remainingAmount,
  MOVEMENT_KINDS,
  SETTLEMENT_CHILD_KINDS,
  realizedCentsOfChildren,
  derivedParentStatus,
  reversalIdempotencyKey,
  splitReceipt,
  statusAfterPartialSettlement,
  receivedCentsOf,
  thirdPartyBalance,
  buildPartialSettlementValues,
  buildExcessPendingValues,
  buildReversalValues,
};
