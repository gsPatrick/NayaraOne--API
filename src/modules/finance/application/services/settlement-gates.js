'use strict';

/**
 * Travas de uma baixa (integral ou parcial) — Caderno §8, §10, §16 e §17; revisão independente A1, A2, A4,
 * B6, C1 e D1. Usadas por receipt.service.js.
 *
 * FIX FIN-004 (auditoria externa Abacus AI, 11/10/2026): a baixa é chamada TANTO pelo fluxo correto de
 * pagamento (executePaymentIntent/confirmBankPayment, só depois de payment_intent aprovado com snapshot/hash —
 * Caderno §8) QUANTO diretamente pela rota HTTP `POST /finance/entries/:id/settle`. `options.viaApprovedPaymentIntent`
 * é passado como `true` SÓ pelos dois chamadores internos legítimos. Alternativamente, a liquidação direta é
 * liberada se já existir uma `ApprovalRequest` APPROVED para este lançamento. RECEIVABLE/TRANSFER/ADJUSTMENT não
 * exigem isso: o Caderno (§10) descreve recebimento como fluxo direto, sem aprovação prévia.
 *
 * Comprovante (A1/A4): TODA baixa de PAYABLE segue a regra — confirmação do banco, compensação aprovada, ou baixa
 * manual com comprovante ANEXADO antes (attachSettlementEvidence) e aprovação posterior de OUTRA pessoa.
 */
const AppError = require('../../../../utils/AppError');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const { SETTLEMENT_METHODS } = require('../../domain/financial-entry');
const { OPEN_STATUSES } = require('../../domain/payment-intent');
const { assertBankAccountEligibleForPayment } = require('./finance-antifraud.service');
const { createAnomalyCase } = require('./anomaly-cases.service');
const { isApprovalRequestApproved, listApprovedDeciders } = require('./approvals.service');
const { assertPeriodOpenForEntry, isPeriodClosed } = require('./competence-guard');
const { assertThirdPartyReleaseStillCovered } = require('./third-party-funds.service');

/**
 * assertNotUnderManualReview (M4-21) — fail closed: um lançamento flagado como anômalo pelo
 * antifraude não pode ser liquidado (total nem parcialmente) enquanto um humano não liberar
 * via `clearManualReview` (finance-antifraud.service.js).
 */
function assertNotUnderManualReview(entry) {
  if (entry.requiresManualReview) {
    throw AppError.conflict(
      'Este lançamento está retido para revisão manual (antifraude) e não pode ser liquidado até ser liberado por um revisor.',
      'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW'
    );
  }
}

async function assertManualSettlementApprovedAfterEvidence(entry, transaction) {
  const deciders = await listApprovedDeciders('FinancialEntry', entry.id, transaction);
  if (deciders.length === 0) {
    throw AppError.conflict(
      'A baixa manual precisa ser aprovada por outra pessoa depois que o comprovante foi anexado — peça a aprovação deste lançamento.',
      'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL'
    );
  }
  if (entry.settlementEvidenceAttachedBy && deciders.every((d) => String(d) === String(entry.settlementEvidenceAttachedBy))) {
    throw AppError.forbidden(
      'Quem anexou o comprovante não pode ser quem aprovou a baixa manual (segregação de funções).',
      'FINANCE_SETTLEMENT_EVIDENCE_SELF_APPROVAL'
    );
  }
}

/**
 * resolvePayableSettlement — decide COMO um PAYABLE pode ser liquidado.
 * Retorna null para lançamentos que não são PAYABLE (recebimentos seguem o fluxo direto, §10).
 */
async function resolvePayableSettlement(entry, options, _transaction) {
  if (entry.nature !== 'PAYABLE') return null;
  const opts = options || {};
  if (opts.viaBankConfirmation) {
    return {
      method: opts.sandboxConfirmation ? SETTLEMENT_METHODS.SANDBOX_CONFIRMED : SETTLEMENT_METHODS.BANK_CONFIRMED,
      evidenceFileId: null,
      reason: null,
    };
  }
  if (opts.viaCompensation) {
    return { method: SETTLEMENT_METHODS.COMPENSATION, evidenceFileId: null, reason: opts.compensationReason || null };
  }

  const attachedFileId = entry.settlementEvidenceFileId ? String(entry.settlementEvidenceFileId) : null;
  const manual = opts.manualSettlement || null;
  const informedFileId = manual && manual.evidenceFileId ? String(manual.evidenceFileId) : null;
  if (!attachedFileId) {
    if (informedFileId) {
      throw AppError.conflict(
        'O comprovante precisa ser anexado ao lançamento ANTES da aprovação (quem aprova vê o arquivo). Anexe o comprovante, peça a aprovação e então dê a baixa.',
        'FINANCE_SETTLEMENT_EVIDENCE_NOT_ATTACHED'
      );
    }
    throw AppError.conflict(
      'Pagamento não pode ser dado como pago sem confirmação do banco. ' +
        'Se o pagamento já foi feito fora da integração bancária, anexe o comprovante e o motivo, peça a aprovação de outra pessoa e então dê a baixa manual.',
      'FINANCE_ENTRY_BANK_SETTLEMENT_REQUIRES_CONFIRMATION'
    );
  }
  if (informedFileId && informedFileId !== attachedFileId) {
    throw AppError.conflict(
      'O comprovante informado na baixa é diferente do comprovante anexado e aprovado para este lançamento.',
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_ATTACHED'
    );
  }
  return { method: SETTLEMENT_METHODS.MANUAL_WITH_EVIDENCE, evidenceFileId: attachedFileId, reason: entry.settlementReason };
}

// A2 (revisão independente): a baixa direta/parcial era aceita com uma intenção de pagamento
// em aberto — inclusive já SUBMITTED ao banco. Depois o banco confirmava e a confirmação dava
// erro em loop (lançamento já liquidado), com risco de pagamento em dobro.
async function assertNoOpenPaymentIntent(entry, exceptIntentId, transaction) {
  const open = await intents.findOneForEntry(entry.id, OPEN_STATUSES, transaction);
  if (open && String(open.id) !== String(exceptIntentId || '')) {
    throw AppError.conflict(
      `Este lançamento tem uma intenção de pagamento em aberto (status "${open.status}") — a baixa só pode acontecer por ela. ` +
        'Aguarde a resposta do banco ou cancele/resolva a intenção antes.',
      'FINANCE_ENTRY_HAS_OPEN_PAYMENT_INTENT',
      { paymentIntentId: open.id, paymentIntentStatus: open.status }
    );
  }
}

async function assertIntentApprovedAfterEvidence(entry, intent) {
  if (!intent) return;
  if (!intent.approvedAt || !entry.settlementEvidenceAttachedAt || new Date(intent.approvedAt) <= new Date(entry.settlementEvidenceAttachedAt)) {
    throw AppError.conflict(
      'A intenção de pagamento foi aprovada antes de o comprovante ser anexado — a execução manual exige aprovação feita vendo o comprovante. Cancele e recrie a intenção depois de anexar.',
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_REVIEWED'
    );
  }
  if (entry.settlementEvidenceAttachedBy && String(intent.approvedByUserId) === String(entry.settlementEvidenceAttachedBy)) {
    throw AppError.forbidden(
      'Quem anexou o comprovante não pode ser quem aprovou a intenção de pagamento (segregação de funções).',
      'FINANCE_SETTLEMENT_EVIDENCE_SELF_APPROVAL'
    );
  }
}

/**
 * runSettlementGates — todas as travas de uma baixa (integral ou parcial), na ordem:
 *   - confirmação do banco (viaBankConfirmation): é registro de um FATO já ocorrido. Não é
 *     recusada por controles de pré-pagamento (conta bloqueada/revisão manual depois do envio —
 *     B6) nem por período fechado (C1): nesses casos liquida no período corrente com referência
 *     ao original e abre caso de anomalia para o contador/revisor.
 *   - demais caminhos: revisão manual, intenção de pagamento em aberto (A2), aprovação prévia
 *     de PAYABLE (A1: com ou sem conta bancária), período aberto, elegibilidade da conta, e
 *     comprovante anexado + aprovação posterior de outra pessoa (A4).
 *   - devolução de caução: saldo da origem revalidado com lock (D1).
 */
async function runSettlementGates(entry, options, transaction) {
  const opts = options || {};
  const viaBankConfirmation = Boolean(opts.viaBankConfirmation);
  const viaCompensation = entry.nature === 'PAYABLE' && entry.thirdPartyReleaseType === 'COMPENSATION';
  const effectiveOptions = { ...opts, viaCompensation };
  const warnings = [];

  if (viaBankConfirmation) {
    if (entry.competenceMonth && (await isPeriodClosed(entry.companyId, entry.competenceMonth, transaction))) {
      warnings.push({
        caseType: 'POST_CLOSING_BANK_CONFIRMATION',
        reason: `Confirmação do banco chegou depois do fechamento de ${entry.competenceMonth} — liquidado no período corrente com referência ao período original (Caderno §16).`,
      });
    }
    if (entry.requiresManualReview) {
      warnings.push({
        caseType: 'BANK_CONFIRMATION_UNDER_REVIEW',
        reason: 'O banco confirmou um pagamento cujo lançamento estava retido para revisão manual — o pagamento já ocorreu; revisar.',
      });
    }
  } else {
    assertNotUnderManualReview(entry);
    await assertNoOpenPaymentIntent(entry, opts.paymentIntent ? opts.paymentIntent.id : null, transaction);
    if (entry.nature === 'PAYABLE' && !opts.viaApprovedPaymentIntent) {
      const hasApprovedRequest = await isApprovalRequestApproved('FinancialEntry', entry.id, transaction);
      if (!hasApprovedRequest) {
        throw AppError.conflict(
          'Pagamento (PAYABLE) não pode ser liquidado sem aprovação prévia — crie um payment_intent com snapshot/hash, ou uma ApprovalRequest aprovada para este lançamento, conforme o fluxo de pagamento do Caderno Técnico.',
          'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL'
        );
      }
    }
    // GAP REAL CORRIGIDO (auditoria externa Nayara, achado A02, 15/10/2026): período fechado.
    await assertPeriodOpenForEntry(entry.companyId, [entry.competenceMonth, new Date()], transaction);
    if (entry.bankAccountId && !viaCompensation) {
      await assertBankAccountEligibleForPayment(entry.bankAccountId, transaction);
    }
  }

  const settlementInfo = await resolvePayableSettlement(entry, effectiveOptions, transaction);
  if (settlementInfo && settlementInfo.method === SETTLEMENT_METHODS.MANUAL_WITH_EVIDENCE) {
    if (opts.viaApprovedPaymentIntent) {
      await assertIntentApprovedAfterEvidence(entry, opts.paymentIntent);
    } else {
      await assertManualSettlementApprovedAfterEvidence(entry, transaction);
    }
  }
  await assertThirdPartyReleaseStillCovered(entry, transaction);
  return { settlementInfo, warnings, viaCompensation };
}

async function recordSettlementWarnings(entry, warnings, actorUserId, transaction) {
  for (const warning of warnings) {
    await createAnomalyCase(
      {
        groupId: entry.groupId,
        companyId: entry.companyId,
        caseType: warning.caseType,
        riskLevel: 'MEDIUM',
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: entry.id,
        reason: warning.reason,
      },
      actorUserId,
      transaction
    );
  }
}

module.exports = { assertNotUnderManualReview, runSettlementGates, recordSettlementWarnings };
