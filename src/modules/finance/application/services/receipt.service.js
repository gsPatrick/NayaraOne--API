'use strict';

/**
 * Recebimento e baixa (Guia M4 §2 receipt.service; Caderno §8, §10, §13, §16 e §17): baixa integral, baixa
 * parcial com excedente em pendência de classificação, e estorno (FIN-010: nunca apaga nem edita o valor do
 * original — cria um lançamento compensatório). As travas da baixa estão em settlement-gates.js; o comprovante
 * da baixa manual em settlement-evidence.service.js; o saldo em ledger-balance.service.js.
 */
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const ledger = require('../../infrastructure/repositories/ledger-movement.repository');
const { SETTLEMENT_METHODS, OPEN_FOR_SETTLEMENT_STATUSES, settlementAuditSuffix, isPositiveAmount, isThirdPartyRelease } = require('../../domain/financial-entry');
const { toCents, fromCents, toBRLDisplay, splitReceipt, statusAfterPartialSettlement, buildPartialSettlementValues, buildExcessPendingValues, buildReversalValues } = require('../../domain/ledger-movement');
const { checkFrequentReversalAlert } = require('./finance-antifraud.service');
const { createAnomalyCase } = require('./anomaly-cases.service');
const { publishFinancialEntrySettled, publishFinancialEntryReversed, publishThirdPartyFundsReleased } = require('./finance-events.service');
const { deriveKey, findPartialReplay, findSettleReplay } = require('./settlement-idempotency');
const { computeRemainingAmount } = require('./ledger-balance.service');
const { runSettlementGates, recordSettlementWarnings } = require('./settlement-gates');
const { assertCompetenceOpen, assertPeriodOpenForEntry } = require('./competence-guard');

async function getEntryForUpdate(id, transaction) {
  const entry = await entries.findByIdForUpdate(id, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

const settledAtOf = (options) => (options && options.settledAt ? new Date(options.settledAt) : new Date());

// D3: efeitos da liquidação de uma saída de dinheiro de terceiro — o evento sai quando o
// dinheiro sai (ou a dívida é abatida), e a compensação baixa a dívida do titular.
async function applyThirdPartySettlementEffects(entry, settledAmount, actorUserId, transaction) {
  if (!isThirdPartyRelease(entry)) return;
  if (entry.thirdPartyReleaseType === 'COMPENSATION' && entry.thirdPartyCompensatedEntryId) {
    await settleFinancialEntryPartial(entry.thirdPartyCompensatedEntryId, settledAmount, actorUserId, transaction, {
      viaCompensationOf: entry.id,
    });
  }
  await publishThirdPartyFundsReleased(entry, transaction);
}

/** settleFinancialEntry — baixa/liquida o lançamento (marca como pago/recebido), depois de todas as travas. */
async function settleFinancialEntry(id, actorUserId, transaction, options = {}) {
  // Lock pessimista: sem ele, duas chamadas concorrentes (dois cliques, retry) liquidavam as duas.
  const entry = await getEntryForUpdate(id, transaction);
  const settleKey = deriveKey('baixa-integral', entry.companyId, options && options.idempotencyKey);
  const settleReplay = await findSettleReplay(entry, settleKey, transaction); // FIN-004: mesma chave = baixa original
  if (settleReplay) return settleReplay;
  if (entry.status === 'PARTIALLY_SETTLED') {
    throw AppError.conflict(
      'Este lançamento já tem baixas parciais — use a liquidação parcial do saldo restante (settleFinancialEntryPartial) para fechá-lo.',
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível liquidar um lançamento PENDING (atual: "${entry.status}").`, 'FINANCE_ENTRY_INVALID_STATUS');
  }
  const { settlementInfo, warnings } = await runSettlementGates(entry, options, transaction);
  const beforeJson = entry.toJSON();

  entry.status = 'SETTLED';
  // Data efetiva do caixa informada por quem recebeu (ex.: comissão paga ontem); sem ela, agora.
  entry.settledAt = settledAtOf(options);
  if (settlementInfo) {
    entry.settlementMethod = settlementInfo.method;
    entry.settlementEvidenceFileId = settlementInfo.evidenceFileId;
    entry.settlementReason = settlementInfo.reason;
  }
  entry.updatedBy = actorUserId || null;
  await entries.save(entry, transaction);

  await publishFinancialEntrySettled(entry, transaction);
  await applyThirdPartySettlementEffects(entry, entry.amount, actorUserId, transaction);
  await recordSettlementWarnings(entry, warnings, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settle',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: settleKey ? { ...entry.toJSON(), settlementIdempotencyKey: settleKey } : entry.toJSON(),
      reason: `Lançamento de ${toBRLDisplay(entry.amount)} liquidado.${settlementAuditSuffix(settlementInfo)}${warnings.map((w) => ` ${w.reason}`).join('')}`,
    },
    transaction
  );

  return entry;
}

/** settleFinancialEntryPartial — baixa parcial (M4-06); 0 < partialAmount, excedente vira pendência de classificação (§10). */
async function settleFinancialEntryPartial(id, partialAmount, actorUserId, transaction, options = {}) {
  // Lock pessimista no pai: sem ele, duas baixas concorrentes somadas passariam do total.
  const entry = await getEntryForUpdate(id, transaction);
  if (!isPositiveAmount(partialAmount)) {
    throw AppError.badRequest('Informe um valor maior que zero.', 'FINANCE_ENTRY_VALIDATION');
  }
  // FIN-004: a chave do cliente (obrigatória na rota HTTP) é gravada na filha; repetir a mesma baixa devolve a original.
  const partialKey = deriveKey('baixa-parcial', entry.companyId, options && options.idempotencyKey);
  const partialReplay = await findPartialReplay(entry, partialKey, partialAmount, transaction, computeRemainingAmount);
  if (partialReplay) return partialReplay;
  if (!OPEN_FOR_SETTLEMENT_STATUSES.includes(entry.status)) {
    throw AppError.conflict(
      `Só é possível liquidar parcialmente um lançamento PENDING ou PARTIALLY_SETTLED (atual: "${entry.status}").`,
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  // A01/A1/A2/A4/D1 — mesmas travas da baixa integral (runSettlementGates). Baixa parcial não é
  // caminho alternativo para contornar aprovação, comprovante, intenção em aberto ou período.
  if (entry.thirdPartyReleaseType === 'COMPENSATION') {
    throw AppError.conflict(
      'Compensação de caução é liquidada de uma vez (baixa integral), não em parcelas.',
      'FINANCE_THIRD_PARTY_COMPENSATION_PARTIAL_FORBIDDEN'
    );
  }
  const compensationOf = options && options.viaCompensationOf ? options.viaCompensationOf : null;
  const gates = compensationOf ? { settlementInfo: null, warnings: [] } : await runSettlementGates(entry, options, transaction);
  if (compensationOf) {
    // Baixa da DÍVIDA do titular abatida por uma compensação de caução já aprovada e liquidada
    // na mesma transação (applyThirdPartySettlementEffects) — período e lançamento conferidos.
    await assertPeriodOpenForEntry(entry.companyId, [entry.competenceMonth, new Date()], transaction);
  }
  const settlementInfo = compensationOf
    ? { method: SETTLEMENT_METHODS.COMPENSATION, evidenceFileId: null, reason: `Abatida por compensação de caução (lançamento ${compensationOf}).` }
    : gates.settlementInfo;

  const partialCents = toCents(partialAmount);
  const remainingCents = toCents(await computeRemainingAmount(entry, transaction));
  if (compensationOf && partialCents > remainingCents) {
    throw AppError.conflict('A compensação passa do saldo em aberto da dívida.', 'FINANCE_THIRD_PARTY_COMPENSATION_EXCEEDS_DEBT');
  }

  // FIX (auditoria externa 2026-10-07 — contrato bruto, Centro Financeiro §10 "Recebimentos e
  // parcelas"): recebimento é sempre ACEITO; o EXCEDENTE acima do saldo restante vira pendência
  // de classificação (nature=PENDING_CLASSIFICATION, status PENDING) — nunca receita automática.
  const { appliedCents, excessCents } = splitReceipt(partialCents, remainingCents);

  const beforeJson = entry.toJSON();

  const settlement = await ledger.createMovement(
    buildPartialSettlementValues(entry, { appliedCents, settledAt: settledAtOf(options), idempotencyKey: partialKey, settlementInfo, actorUserId }),
    transaction
  );

  let classificationPending = null;
  if (excessCents > 0) {
    classificationPending = await ledger.createMovement(buildExcessPendingValues(entry, { excessCents, idempotencyKey: partialKey, actorUserId }), transaction);
  }

  const newRemainingCents = remainingCents - appliedCents;
  entry.status = statusAfterPartialSettlement(newRemainingCents);
  if (newRemainingCents === 0) entry.settledAt = settledAtOf(options);
  if (newRemainingCents === 0 && settlementInfo) {
    entry.settlementMethod = settlementInfo.method;
    entry.settlementEvidenceFileId = settlementInfo.evidenceFileId;
    entry.settlementReason = settlementInfo.reason;
  }
  entry.updatedBy = actorUserId || null;
  await entries.save(entry, transaction);

  await publishFinancialEntrySettled(settlement, transaction);
  if (isThirdPartyRelease(entry)) {
    await publishThirdPartyFundsReleased(settlement, transaction);
  }
  await recordSettlementWarnings(entry, gates.warnings, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settle_partial',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: {
        original: entry.toJSON(),
        settlementEntryId: settlement.id,
        idempotencyKey: partialKey,
        appliedAmount: fromCents(appliedCents),
        remainingAmount: fromCents(newRemainingCents),
        excessAmount: excessCents > 0 ? fromCents(excessCents) : '0.00',
        classificationPendingEntryId: classificationPending ? classificationPending.id : null,
      },
      reason:
        excessCents > 0
          ? `Recebimento de ${fromCents(partialCents)} processado: ${fromCents(appliedCents)} baixou o ` +
            `lançamento de ${entry.amount} (saldo restante ${fromCents(newRemainingCents)}) e ${fromCents(excessCents)} ` +
            `excedente abriu pendência de classificação ${classificationPending.id} — nunca tratado como receita.`
          : `Baixa parcial de ${fromCents(appliedCents)} registrada no lançamento de ${entry.amount} ` +
            `(saldo restante ${fromCents(newRemainingCents)}).${settlementAuditSuffix(settlementInfo)}`,
    },
    transaction
  );

  return { original: entry, settlement, remainingAmount: fromCents(newRemainingCents), classificationPending };
}

/**
 * reverseFinancialEntry — ESTORNO. Nunca apaga nem edita o valor do lançamento original (FIN-010):
 * marca o original como REVERSED e cria um novo lançamento compensatório (`entryType`
 * invertido, mesmo `amount`) apontando de volta via `reversalOfEntryId`.
 */
async function reverseFinancialEntry(id, reasonText, actorUserId, transaction, options = {}) {
  // Lock pessimista: duas chamadas concorrentes de estorno pro mesmo lançamento não podem ambas
  // ler status != REVERSED antes de qualquer uma commitar (senão criam DOIS compensatórios).
  const original = await getEntryForUpdate(id, transaction);
  if (original.status === 'REVERSED') {
    throw AppError.conflict('Este lançamento já foi estornado.', 'FINANCE_ENTRY_ALREADY_REVERSED');
  }
  if (original.status === 'CANCELLED') {
    throw AppError.conflict('Lançamento cancelado não pode ser estornado.', 'FINANCE_ENTRY_INVALID_STATUS');
  }

  // D1 (revisão independente, provado): estornar o recebimento de uma caução já devolvida
  // deixava o saldo da origem negativo. Com devolução/compensação ativa, estorne a saída antes.
  if (original.isThirdPartyFunds && original.nature === 'RECEIVABLE') {
    const activeRelease = await entries.findOneActiveRelease(original.id, transaction);
    if (activeRelease) {
      throw AppError.conflict(
        'Esta caução já tem devolução/compensação registrada — estorne a saída antes de estornar o recebimento.',
        'FINANCE_THIRD_PARTY_ORIGIN_HAS_RELEASES',
        { releaseEntryId: activeRelease.id }
      );
    }
  }

  // FIX (homologação 22/09/2026): o estorno cria um NOVO lançamento compensatório (SETTLED) na
  // mesma competência do original — o mês precisa estar aberto (e não em revisão).
  await assertPeriodOpenForEntry(original.companyId, [original.competenceMonth, new Date()], transaction);
  await assertCompetenceOpen(original.companyId, original.competenceMonth, transaction);

  // Estorno parcial (ex.: o banco devolve só parte da comissão): lançamento compensatório só do valor
  // informado; o original continua como está até o estorno final.
  const partialCents = options.amount !== undefined && options.amount !== null ? toCents(options.amount) : null;
  const isPartial = partialCents !== null && partialCents < toCents(original.amount);
  if (partialCents !== null && (partialCents <= 0 || partialCents > toCents(original.amount))) {
    throw AppError.badRequest('O valor do estorno precisa ser maior que zero e no máximo o valor do lançamento.', 'FINANCE_ENTRY_VALIDATION');
  }

  const beforeJson = original.toJSON();
  const reversal = await ledger.createMovement(buildReversalValues(original, { isPartial, partialCents, actorUserId }), transaction);

  if (!isPartial) {
    original.status = 'REVERSED';
    original.updatedBy = actorUserId || null;
    await entries.save(original, transaction);
    await publishFinancialEntryReversed(original, reversal, transaction);
  }

  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'finance.entry.reverse',
      entityType: 'FinancialEntry',
      entityId: original.id,
      beforeJson,
      afterJson: { original: original.toJSON(), reversalEntryId: reversal.id, partial: isPartial },
      reason: `${isPartial ? `Lançamento estornado em parte (${toBRLDisplay(fromCents(partialCents))})` : 'Lançamento estornado'}${reasonText ? `: ${reasonText}` : '.'}`,
    },
    transaction
  );

  // Caderno §17 "Estorno frequente -> Anomaly case": a cada estorno, confere se a empresa cruzou o
  // limiar e abre um caso de anomalia. Estorno de origem comercial (chargeback de comissão do banco)
  // não é sinal de fraude: fica fora do alerta. DEC-007: por empresa e pela pessoa que estornou.
  const reversalAlert = options.skipFrequentAlert ? { flagged: false } : await checkFrequentReversalAlert(original.companyId, transaction, actorUserId);
  if (reversalAlert.flagged) {
    await createAnomalyCase(
      {
        groupId: original.groupId,
        companyId: original.companyId,
        caseType: 'FREQUENT_REVERSAL',
        riskLevel: 'MEDIUM', // M4-D006 item 9 e M4-D022 item 8: FREQUENT_REVERSALS MEDIUM (DI-DEC007-6)
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: original.id,
        reason: reversalAlert.reason,
      },
      actorUserId,
      transaction
    );
  }

  return { original, reversal };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * reverseLedgerMovement — Guia §15 POST /finance/ledger/:id/reverse: o id é o da linha da view finance.ledger
 * (cada movimento realizado tem o id do próprio lançamento liquidado ou da baixa parcial filha). Só movimento que
 * está no ledger pode ser estornado por aqui; o estorno é o mesmo de reverseFinancialEntry.
 */
async function reverseLedgerMovement(id, reasonText, actorUserId, transaction) {
  const rows = UUID.test(id) ? await ledger.findLedgerRows(id, transaction) : [];
  if (rows.length === 0) {
    throw AppError.notFound('Movimento não encontrado no ledger (só movimento realizado pode ser estornado).', 'FINANCE_LEDGER_MOVEMENT_NOT_FOUND');
  }
  return reverseFinancialEntry(id, reasonText, actorUserId, transaction);
}

module.exports = {
  settleFinancialEntry,
  settleFinancialEntryPartial,
  reverseFinancialEntry,
  reverseLedgerMovement,
  SETTLEMENT_METHODS,
};
