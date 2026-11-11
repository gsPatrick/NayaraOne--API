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
const { toCents, fromCents, toBRLDisplay, splitReceipt, statusAfterPartialSettlement, buildPartialSettlementValues, buildExcessPendingValues, MOVEMENT_KINDS } = require('../../domain/ledger-movement');
const { checkFrequentReversalAlert } = require('./finance-antifraud.service');
const { createAnomalyCase } = require('./anomaly-cases.service');
const { publishFinancialEntrySettled, publishThirdPartyFundsReleased } = require('./finance-events.service');
const { deriveKey, findPartialReplay, findSettleReplay, movementKeyForSettle, movementKeyForPartial } = require('./settlement-idempotency');
const { lockForReversal, applyReversal } = require('./reversal-movements');
const { readBankAccountRequired } = require('./ledger-settings');
const { computeRemainingAmount } = require('./ledger-balance.service');
const { runSettlementGates, recordSettlementWarnings } = require('./settlement-gates');
const { assertCompetenceOpen, assertPeriodOpenForEntry } = require('./competence-guard');

async function getEntryForUpdate(id, transaction) {
  const entry = await entries.findByIdForUpdate(id, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

// Caderno §7 (bank_account_id no movimento): com o parâmetro ligado (DI-M4LR-1), nenhuma baixa entra no ledger sem a conta.
async function assertLedgerBankAccount(entry, options, transaction) {
  const hasAccount = entry.bankAccountId || (options.paymentIntent && options.paymentIntent.bankAccountId);
  if (hasAccount || !(await readBankAccountRequired({ companyId: entry.companyId, groupId: entry.groupId }, transaction))) return;
  throw AppError.conflict('Informe a conta bancária do lançamento antes da baixa: a empresa exige a conta em todo movimento do ledger.', 'FINANCE_LEDGER_BANK_ACCOUNT_REQUIRED');
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
  if (entry.status === 'PARTIALLY_SETTLED' || (entry.status === 'PENDING' && (await ledger.hasSettlementChildren(entry.id, transaction)))) {
    throw AppError.conflict(
      'Este lançamento já tem baixas parciais — use a liquidação parcial do saldo restante (settleFinancialEntryPartial) para fechá-lo.',
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível liquidar um lançamento PENDING (atual: "${entry.status}").`, 'FINANCE_ENTRY_INVALID_STATUS');
  }
  const { settlementInfo, warnings } = await runSettlementGates(entry, options, transaction);
  await assertLedgerBankAccount(entry, options, transaction);
  const beforeJson = entry.toJSON();

  entry.status = 'SETTLED';
  // Data efetiva do caixa informada por quem recebeu (ex.: comissão paga ontem); sem ela, agora.
  entry.settledAt = settledAtOf(options);
  // Caderno §7 / FIN-004: o lançamento vira linha do ledger e o movimento nasce com chave (a do cliente, a da intenção de
  // pagamento — Guia §7 — ou a interna desta baixa única).
  entry.settlementIdempotencyKey = movementKeyForSettle(entry, settleKey, options);
  // Guia §7: o movimento confirmado pelo banco leva a conta da intenção (bank_account_id NOT NULL no ledger, §7).
  if (!entry.bankAccountId && options.paymentIntent && options.paymentIntent.bankAccountId) entry.bankAccountId = options.paymentIntent.bankAccountId;
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
    throw AppError.badRequest('Informe um valor maior que zero, em decimal simples (ex.: 0.10), de pelo menos R$ 0,01.', 'FINANCE_ENTRY_VALIDATION');
  }
  // FIN-004: a chave do cliente (obrigatória na rota HTTP) é gravada na filha; repetir a mesma baixa devolve a original.
  const partialKey = deriveKey(options.movementKind === MOVEMENT_KINDS.COMPLEMENT ? 'complemento' : 'baixa-parcial', entry.companyId, options && options.idempotencyKey);
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
  await assertLedgerBankAccount(entry, options, transaction);

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

  // FIN-004: o movimento sempre nasce com chave — a do cliente (derivada) ou a interna (compensação de caução ou uuid).
  const movementKey = partialKey || movementKeyForPartial(compensationOf);
  const movementKind = options.movementKind === MOVEMENT_KINDS.COMPLEMENT ? MOVEMENT_KINDS.COMPLEMENT : MOVEMENT_KINDS.PARTIAL;
  const settlement = await ledger.createMovement(
    buildPartialSettlementValues(entry, { appliedCents, settledAt: settledAtOf(options), idempotencyKey: movementKey, settlementInfo, actorUserId, movementKind }),
    transaction
  );

  let classificationPending = null;
  if (excessCents > 0) {
    classificationPending = await ledger.createMovement(buildExcessPendingValues(entry, { excessCents, idempotencyKey: movementKey, actorUserId }), transaction);
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
      action: movementKind === MOVEMENT_KINDS.COMPLEMENT ? 'finance.entry.settle_complement' : 'finance.entry.settle_partial',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: {
        original: entry.toJSON(),
        settlementEntryId: settlement.id,
        idempotencyKey: movementKey,
        movementKind,
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
          : `${movementKind === MOVEMENT_KINDS.COMPLEMENT ? 'Complemento (quitação do saldo)' : 'Baixa parcial'} de ${fromCents(appliedCents)} registrada no lançamento de ${entry.amount} ` +
            `(saldo restante ${fromCents(newRemainingCents)}).${settlementAuditSuffix(settlementInfo)}`,
    },
    transaction
  );

  return { original: entry, settlement, remainingAmount: fromCents(newRemainingCents), classificationPending };
}

/**
 * settleFinancialEntryComplement — COMPLEMENTO (Caderno §6: "Um entry pode ter múltiplos movimentos de ledger (pagamento
 * parcial, estorno, complemento)"). Quita exatamente o saldo em aberto de um lançamento que já tem movimento (baixa
 * parcial, inclusive uma baixa estornada): um movimento COMPLEMENT no ledger, com as mesmas travas e a mesma chave
 * obrigatória da baixa parcial. `expectedAmount` (o saldo que a tela mostrou) evita quitar um saldo que mudou. DI-M4LR-4.
 */
async function settleFinancialEntryComplement(id, actorUserId, transaction, options = {}) {
  const entry = await getEntryForUpdate(id, transaction);
  const replayKey = deriveKey('complemento', entry.companyId, options.idempotencyKey);
  const previous = replayKey ? await entries.findByIdempotencyKey(replayKey, transaction) : null;
  if (previous) return settleFinancialEntryPartial(id, previous.amount, actorUserId, transaction, { ...options, movementKind: MOVEMENT_KINDS.COMPLEMENT });
  if (!(await ledger.hasSettlementChildren(entry.id, transaction))) {
    throw AppError.conflict('Este lançamento ainda não tem movimento no ledger: use a baixa integral (o complemento quita o saldo depois de uma baixa parcial ou de um estorno).', 'FINANCE_COMPLEMENT_WITHOUT_MOVEMENT');
  }
  const remaining = await computeRemainingAmount(entry, transaction);
  if (toCents(remaining) <= 0) {
    throw AppError.conflict('Não há saldo em aberto para complementar.', 'FINANCE_COMPLEMENT_NOTHING_OPEN');
  }
  if (options.expectedAmount !== undefined && options.expectedAmount !== null && toCents(options.expectedAmount) !== toCents(remaining)) {
    throw AppError.conflict(`O saldo em aberto mudou: agora é ${toBRLDisplay(remaining)}. Confira e confirme de novo.`, 'FINANCE_COMPLEMENT_AMOUNT_CHANGED', { remainingAmount: remaining });
  }
  return settleFinancialEntryPartial(id, remaining, actorUserId, transaction, { ...options, movementKind: MOVEMENT_KINDS.COMPLEMENT });
}

/**
 * reverseFinancialEntry — ESTORNO. Nunca apaga nem edita o valor do lançamento original (FIN-010). O que vai para o
 * ledger segue o Caderno §6 (reversal-movements.js): lançamento não realizado não tem movimento a estornar (só fica
 * REVERSED); movimento realizado ganha um REVERSAL (tipo invertido) apontando para ele via `reversalOfEntryId`, com
 * chave `reversal:<movimento>:<caso>`; o pai com baixas parciais estorna cada baixa.
 */
async function reverseFinancialEntry(id, reasonText, actorUserId, transaction, options = {}) {
  // Lock pessimista: duas chamadas concorrentes de estorno pro mesmo lançamento não podem ambas
  // ler status != REVERSED antes de qualquer uma commitar (senão criam DOIS compensatórios). Trava o pai antes da filha.
  const original = await lockForReversal(id, transaction);
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

  // O que o estorno lança no ledger (§6/Guia §8): nada para o não realizado; REVERSAL por movimento realizado (o pai com
  // baixas parciais estorna cada baixa). Estorno parcial (ex.: o banco devolve só parte da comissão): só o valor
  // informado; o movimento continua de pé até o estorno final. Regras em reversal-movements.js.
  const beforeJson = original.toJSON();
  const applied = await applyReversal(original, { partialAmount: options.amount, actorUserId, reasonText, options }, transaction);
  const { reversal, isPartial, partialCents } = applied;

  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'finance.entry.reverse',
      entityType: 'FinancialEntry',
      entityId: original.id,
      beforeJson,
      afterJson: {
        original: original.toJSON(),
        reversalEntryId: reversal ? reversal.id : null,
        reversalEntryIds: applied.reversals.map((r) => r.id),
        ledgerEffect: applied.kind,
        partial: isPartial,
      },
      reason: `${isPartial ? `Lançamento estornado em parte (${toBRLDisplay(fromCents(partialCents))})` : 'Lançamento estornado'}${reasonText ? `: ${reasonText}` : '.'}${
        applied.kind === 'NOT_REALIZED' ? ' Lançamento não realizado: nenhum movimento no ledger (Caderno §6).' : ''}${
        applied.kind === 'PARENT_WITH_SETTLEMENTS' ? ` Estornadas ${applied.reversals.length} baixa(s) parcial(is), uma REVERSAL por baixa.` : ''}`,
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
        riskLevel: 'HIGH',
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: original.id,
        reason: reversalAlert.reason,
      },
      actorUserId,
      transaction
    );
  }

  return { original, reversal, reversals: applied.reversals, ledgerEffect: applied.kind };
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
  settleFinancialEntryComplement,
  reverseFinancialEntry,
  reverseLedgerMovement,
  SETTLEMENT_METHODS,
};
