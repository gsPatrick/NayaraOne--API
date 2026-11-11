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
 * ou com caso AMOUNT_OUTLIER aberto não é avaliado de novo. O lançamento retido só é liquidado
 * depois da liberação humana com MFA (POST /finance/entries/:id/clear-manual-review).
 */
const { AnomalyCase } = require('../../models');

async function hasOpenOutlierCase(entryId, transaction) {
  const open = await AnomalyCase.count({ where: { relatedEntityType: 'FinancialEntry', relatedEntityId: entryId, caseType: 'AMOUNT_OUTLIER', status: 'OPEN' }, transaction });
  return open > 0;
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
  if (await hasOpenOutlierCase(entry.id, transaction)) return { flagged: false, skipped: 'open_case' };
  const { flagAnomalousPayment } = require('./financeAntifraud.service');
  return flagAnomalousPayment(entry, transaction);
}

module.exports = { evaluatePayableAnomaly };
