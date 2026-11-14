'use strict';

/**
 * Caderno M4 §17 (FIN-013 "Fraude visível — anomalia gera bloqueio/alerta quando aplicável"):
 *   "Valor fora do padrão -> Anomaly score + revisão" e
 *   "Fornecedor novo de alto valor -> Due diligence/aprovação".
 * Este módulo liga a regra (flagAnomalousPayment, finance-antifraud.service.js) nos pontos em que um pagamento passa a
 * existir ou muda de destino:
 *   - criação de lançamento PAYABLE com conta bancária (createFinancialEntry);
 *   - troca/definição da conta do PAYABLE (updateFinancialEntry, quando não é redirecionamento,
 *     que já retém com BENEFICIARY_CHANGED);
 *   - preparação da intenção de pagamento e pedido de aprovação, se o lançamento ainda não foi
 *     avaliado (ex.: criado antes desta regra ou por outro módulo).
 * Sem duplicar caso: lançamento já retido, já liberado por um humano (na avaliação de preparo)
 * ou com caso do antifraude aberto não é avaliado de novo. O lançamento retido só é liquidado depois da liberação humana com MFA
 * (POST /finance/entries/:id/clear-manual-review). Achado BLOQUEANTE (risco HIGH: duplicidade, múltiplo de bloqueio, conferência que falhou)
 * também impede preparar a intenção ou pedir a aprovação (409) até a liberação (`assertNotBlocked`).
 * DI-DEC007-5: o 409 desfaz a transação da requisição; a retenção e o caso abertos NA PRÓPRIA preparação são gravados de novo numa transação
 * separada, depois do rollback (antifraud-after-rollback.js, mesmo gancho `afterRollbackCleanups` do tenant.middleware).
 */
const { Op } = require('sequelize');
const AppError = require('../../../../utils/AppError');
const { AnomalyCase } = require('../../../../models');
const { FINDING_CASE_TYPES, BLOCKING_RISK_LEVELS } = require('./payable-antifraud-findings');
const { keepFindingsAfterRollback } = require('./antifraud-after-rollback');

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
  const { flagAnomalousPayment } = require('./finance-antifraud.service');
  return flagAnomalousPayment(entry, transaction);
}

const BLOCK_ERRORS = Object.freeze({
  DUPLICATE_PAYMENT_SUSPECT: ['Já existe um pagamento igual para este favorecido, valor e vencimento. Revise e libere o lançamento antes de seguir.', 'FINANCE_DUPLICATE_PAYMENT_SUSPECT'],
  AMOUNT_OUTLIER: ['Valor muito acima do habitual: revisão obrigatória antes de preparar ou aprovar o pagamento.', 'FINANCE_AMOUNT_OUTLIER_REVIEW_REQUIRED'],
  NEW_SUPPLIER_HIGH_VALUE: ['Fornecedor novo de alto valor: conclua a verificação cadastral antes de preparar ou aprovar o pagamento.', 'FINANCE_SUPPLIER_DILIGENCE_REQUIRED'],
  NEW_ACCOUNT_IMMEDIATE_PAYMENT: ['Conta recente: este pagamento exige a revisão de outra pessoa antes de seguir.', 'FINANCE_EXTRA_APPROVAL_REQUIRED'],
});

/**
 * assertNotBlocked — lançamento ainda retido com caso BLOQUEANTE aberto (risco HIGH) não vira intenção de pagamento nem pedido de aprovação.
 * Depois da liberação humana (requiresManualReview = false) o fluxo segue.
 */
async function assertNotBlocked(entry, transaction) {
  if (!entry || !entry.requiresManualReview) return;
  const blocking = await openCasesOf(entry.id, transaction, { riskLevel: { [Op.in]: BLOCKING_RISK_LEVELS } });
  if (!blocking.length) return;
  const first = blocking.find((c) => c.caseType === 'DUPLICATE_PAYMENT_SUSPECT') || blocking[0];
  const [message, code] = BLOCK_ERRORS[first.caseType];
  throw AppError.conflict(message, code, { anomalyCaseId: first.id });
}

/**
 * Avaliação na preparação (intenção ou pedido de aprovação) seguida da trava do achado bloqueante. Se a avaliação desta chamada reteve o
 * lançamento e a trava recusa, a retenção e os casos são regravados depois do rollback (DI-DEC007-5).
 */
async function evaluateAndAssertPreparable(entry, transaction, actorUserId = null) {
  const result = await evaluatePayableAnomaly(entry, transaction, 'prepare');
  try {
    await assertNotBlocked(entry, transaction);
  } catch (err) {
    if (result.flagged) keepFindingsAfterRollback(entry, actorUserId, transaction);
    throw err;
  }
}

module.exports = { evaluatePayableAnomaly, assertNotBlocked, evaluateAndAssertPreparable };
