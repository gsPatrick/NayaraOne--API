'use strict';

/**
 * Caderno M4 §17 (FIN-013 "Fraude visível — anomalia gera bloqueio/alerta quando aplicável"):
 *   "Valor fora do padrão -> Anomaly score + revisão" e
 *   "Fornecedor novo de alto valor -> Due diligence/aprovação".
 * A regra (flagAnomalousPayment, financeAntifraud.service.js) existia mas nunca era chamada no
 * fluxo real — só pelos testes. Este módulo liga a regra nos pontos em que um pagamento passa a
 * existir ou muda de destino:
 *   - criação de lançamento PAYABLE com conta bancária (createFinancialEntry);
 *   - troca/definição da conta do PAYABLE (updateFinancialEntry, quando não é redirecionamento,
 *     que já retém com BENEFICIARY_CHANGED);
 *   - preparação da intenção de pagamento e pedido de aprovação, se o lançamento ainda não foi
 *     avaliado (ex.: criado antes desta regra ou por outro módulo).
 * Sem duplicar caso: lançamento já retido, já liberado por um humano (na avaliação de preparo)
 * ou com caso do antifraude aberto (duplicidade, valor fora do padrão, fornecedor novo) não é
 * avaliado de novo. O lançamento retido só é liquidado depois da liberação humana com MFA
 * (POST /finance/entries/:id/clear-manual-review). DEC-007 "10,0 bloqueia" e "duplicidade": o
 * lançamento retido por achado BLOQUEANTE também não avança — preparar a intenção ou pedir a
 * aprovação é recusado (409) até a liberação (`assertNotBlocked`).
 */
const { Op } = require('sequelize');
const AppError = require('../../utils/AppError');
const { AnomalyCase } = require('../../models');
const { FINDING_CASE_TYPES } = require('./payableAntifraudFindings');

const openCasesOf = (entryId, transaction, where = {}) =>
  AnomalyCase.findAll({ where: { relatedEntityType: 'FinancialEntry', relatedEntityId: entryId, caseType: FINDING_CASE_TYPES, status: 'OPEN', ...where }, transaction });

async function hasOpenFindingCase(entryId, transaction) {
  return (await openCasesOf(entryId, transaction)).length > 0;
}

// Fora da regra: saída de dinheiro de TERCEIRO (repasse ao proprietário, devolução/compensação de
// caução). Ela já nasce de um fluxo com controle próprio do livro (§12: repasse aprovado por outra
// pessoa com MFA e limitado ao valor elegível recebido; §13: caução vinculada a contrato e titular),
// e a conta do lançamento é a de SAÍDA da empresa, não o histórico de um favorecido.
function isEvaluable(entry) {
  return Boolean(entry && entry.nature === 'PAYABLE' && entry.status === 'PENDING' && entry.bankAccountId && !entry.isThirdPartyFunds);
}

/**
 * evaluatePayableAnomaly — `moment`: 'create' | 'update' | 'prepare'. Na preparação, um
 * lançamento já liberado por revisor humano (manualReviewClearedAt) não é retido de novo pelo
 * mesmo fato. Devolve o resultado de flagAnomalousPayment ou { flagged: false, skipped }.
 */
async function evaluatePayableAnomaly(entry, transaction, moment = 'create') {
  if (!isEvaluable(entry)) return { flagged: false, skipped: 'not_applicable' };
  if (entry.requiresManualReview) return { flagged: false, skipped: 'already_under_review' };
  if (moment === 'prepare' && entry.manualReviewClearedAt) return { flagged: false, skipped: 'cleared_by_reviewer' };
  if (await hasOpenFindingCase(entry.id, transaction)) return { flagged: false, skipped: 'open_case' };
  const { flagAnomalousPayment } = require('./financeAntifraud.service');
  return flagAnomalousPayment(entry, transaction);
}

/**
 * assertNotBlocked — lançamento ainda retido com caso BLOQUEANTE aberto (duplicidade suspeita ou valor a partir do múltiplo de bloqueio) não vira
 * intenção de pagamento nem pedido de aprovação. Depois da liberação humana (requiresManualReview = false) o fluxo segue.
 */
async function assertNotBlocked(entry, transaction) {
  if (!entry || !entry.requiresManualReview) return;
  const blocking = await openCasesOf(entry.id, transaction, {
    [Op.or]: [{ caseType: 'DUPLICATE_PAYMENT_SUSPECT' }, { caseType: 'AMOUNT_OUTLIER', riskLevel: 'CRITICAL' }],
  });
  const duplicate = blocking.find((c) => c.caseType === 'DUPLICATE_PAYMENT_SUSPECT');
  if (duplicate) {
    throw AppError.conflict('Já existe um pagamento igual para este favorecido, valor e vencimento. Revise e libere o lançamento antes de seguir.', 'FINANCE_DUPLICATE_PAYMENT_SUSPECT', { anomalyCaseId: duplicate.id });
  }
  if (blocking.length) {
    throw AppError.conflict('Valor muito acima do habitual: revisão obrigatória antes de preparar ou aprovar o pagamento.', 'FINANCE_AMOUNT_OUTLIER_REVIEW_REQUIRED', { anomalyCaseId: blocking[0].id });
  }
}

/** Avaliação na preparação (intenção ou pedido de aprovação) seguida da trava do achado bloqueante. */
async function evaluateAndAssertPreparable(entry, transaction) {
  await evaluatePayableAnomaly(entry, transaction, 'prepare');
  await assertNotBlocked(entry, transaction);
}

module.exports = { evaluatePayableAnomaly, assertNotBlocked, evaluateAndAssertPreparable };
