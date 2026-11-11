'use strict';

/**
 * O que o estorno lança no ledger (Caderno M4 §6 "Estorno: mantém histórico/status derivado — REVERSAL apontando
 * movement original"; Guia §8 reverseLedger; FIN-003/FIN-010). Verificação independente 11/11/2026, sondas P2, P3, P4:
 *   - lançamento NÃO realizado (PENDING sem baixa): o ledger não tem movimento ("Conta a pagar futura | OPEN | Nenhum"),
 *     então o estorno não lança nada: é recusado (FINANCE_ENTRY_NOT_REALIZED), ou, com `voidNotRealized`, o previsto só
 *     passa a REVERSED (sai de a pagar/a receber), com auditoria e sem linha no ledger;
 *   - movimento realizado (baixa integral, baixa parcial filha, complemento): REVERSAL com a direção invertida, na conta
 *     do original, apontando o movimento, com chave `reversal:<movimento>:<caso>`; total = o que ainda não foi estornado
 *     do movimento, parcial = o informado (até esse limite);
 *   - lançamento com baixas parciais (o pai não é linha do ledger — as filhas é que são): estornar o pai estorna CADA
 *     baixa filha ainda de pé pelo que falta estornar dela; o pai fica REVERSED sem linha própria. Nunca mais o REVERSAL
 *     do valor cheio do pai sobre 0,10 baixado (ledger da família em −0,20);
 *   - estornar uma baixa filha recalcula o status do pai pelo ledger (o saldo volta a ser baixável).
 * O fluxo de autorização do estorno (quem pode, aprovação) é de receipt.service.js / do confirmAction da rota.
 */
const crypto = require('node:crypto');
const AppError = require('../../../../utils/AppError');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const ledger = require('../../infrastructure/repositories/ledger-movement.repository');
const { toCents, fromCents, buildReversalValues, reversalIdempotencyKey } = require('../../domain/ledger-movement');
const { publishFinancialEntryReversed } = require('./finance-events.service');
const { refreshParentStatus } = require('./ledger-balance.service');

/**
 * Trava para o estorno na ordem pai -> filho (a mesma da baixa parcial, que trava o pai): estornar uma baixa filha e
 * estornar o pai ao mesmo tempo não se cruzam em deadlock.
 */
async function lockForReversal(id, transaction) {
  const plain = await entries.findById(id, transaction);
  if (plain && plain.parentEntryId) await entries.findByIdForUpdate(plain.parentEntryId, transaction);
  const entry = await entries.findByIdForUpdate(id, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

function caseRefFor(original, options, isPartial, ordinal) {
  if (options.approvedCaseId) return String(options.approvedCaseId);
  if (options.idempotencyKey) return crypto.createHash('sha256').update(`${original.companyId}:${options.idempotencyKey}`).digest('hex').slice(0, 32);
  return isPartial ? `parcial-${ordinal}` : 'total';
}

/** Estorna UM movimento realizado: total (o que falta estornar) ou parcial (`partialCents`). */
async function reverseMovement(movement, { partialCents = null, actorUserId, options = {} }, transaction) {
  const reversedBefore = (await ledger.reversedCentsByMovement([movement.id], transaction)).get(movement.id) || 0;
  const standingCents = toCents(movement.amount) - reversedBefore;
  if (standingCents <= 0) return null;
  if (partialCents !== null && (partialCents <= 0 || partialCents > standingCents)) {
    throw AppError.badRequest(
      `O valor do estorno precisa ser maior que zero e no máximo o que ainda não foi estornado deste movimento (${fromCents(standingCents)}).`,
      'FINANCE_ENTRY_VALIDATION'
    );
  }
  const amountCents = partialCents === null ? standingCents : partialCents;
  const isPartial = amountCents < standingCents;
  const ordinal = (await ledger.countReversalsOf(movement.id, transaction)) + 1;
  const idempotencyKey = reversalIdempotencyKey(movement.id, caseRefFor(movement, options, isPartial, ordinal));
  const reversal = await ledger.createMovement(buildReversalValues(movement, { isPartial, amountCents, idempotencyKey, actorUserId }), transaction);
  if (!isPartial) {
    movement.status = 'REVERSED';
    movement.updatedBy = actorUserId || null;
    await entries.save(movement, transaction);
    // O evento do estorno sai quando o movimento termina estornado (como antes): o parcial não é "pagamento revertido".
    await publishFinancialEntryReversed(movement, reversal, transaction);
  }
  return { reversal, isPartial };
}

/**
 * applyReversal — decide e lança o estorno de `original` (já travado). Devolve:
 *   { kind: 'NOT_REALIZED' | 'MOVEMENT' | 'PARENT_WITH_SETTLEMENTS', reversal, reversals, isPartial, partialCents }.
 */
async function applyReversal(original, { partialAmount, actorUserId, reasonText, options = {} }, transaction) {
  const partialCents = partialAmount !== undefined && partialAmount !== null ? toCents(partialAmount) : null;
  if (await ledger.hasSettlementChildren(original.id, transaction)) {
    if (partialCents !== null) {
      throw AppError.conflict(
        'Este lançamento foi recebido/pago em baixas parciais: o estorno parcial é feito na baixa específica (cada baixa é um movimento do ledger).',
        'FINANCE_REVERSAL_PARTIAL_ON_PARENT'
      );
    }
    const reversals = [];
    for (const child of await ledger.findSettlementChildren(original.id, transaction)) {
      const locked = await entries.findByIdForUpdate(child.id, transaction);
      const done = await reverseMovement(locked, { actorUserId, options }, transaction);
      if (done) reversals.push(done.reversal);
    }
    original.status = 'REVERSED';
    original.updatedBy = actorUserId || null;
    await entries.save(original, transaction);
    return { kind: 'PARENT_WITH_SETTLEMENTS', reversal: reversals[0] || null, reversals, isPartial: false, partialCents: null };
  }
  const realized = original.status === 'SETTLED' && original.settledAt;
  if (!realized) {
    // §6: previsto não realizado não tem movimento no ledger. Anular o previsto (REVERSED, sem lançamento compensatório) só
    // com o pedido explícito de quem chama (`voidNotRealized`: a tela de estorno e os fluxos de compra/seguro que anulam a
    // conta em aberto); sem ele, o estorno é recusado — nunca mais um REVERSAL de dinheiro que não existiu.
    if (partialCents !== null || !options.voidNotRealized) {
      throw AppError.conflict(
        'Este lançamento ainda não foi realizado (não há pagamento nem recebimento no ledger): não há movimento para estornar. Para tirá-lo de a pagar/a receber, anule o previsto.',
        'FINANCE_ENTRY_NOT_REALIZED'
      );
    }
    original.status = 'REVERSED';
    original.updatedBy = actorUserId || null;
    await entries.save(original, transaction);
    return { kind: 'NOT_REALIZED', reversal: null, reversals: [], isPartial: false, partialCents: null };
  }
  const done = await reverseMovement(original, { partialCents, actorUserId, options }, transaction);
  if (!done) throw AppError.conflict('Este movimento já foi estornado por inteiro.', 'FINANCE_ENTRY_ALREADY_REVERSED');
  if (original.parentEntryId) await refreshParentStatus(original.parentEntryId, actorUserId, transaction, reasonText ? `Motivo do estorno: ${reasonText}` : '');
  return { kind: 'MOVEMENT', reversal: done.reversal, reversals: [done.reversal], isPartial: done.isPartial, partialCents };
}

module.exports = { lockForReversal, applyReversal, reverseMovement };
