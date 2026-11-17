'use strict';

/**
 * Erros de negócio dos campos obrigatórios do lançamento próprio em aberto (regra pura em domain/open-entry-required.js; DI-BI2-6):
 *  - FINANCE_ENTRY_DUE_DATE_REQUIRED (422): a pagar ou a receber próprio sem vencimento (criação, edição que apaga, excedente como despesa);
 *  - FINANCE_ENTRY_COST_CENTER_REQUIRED / FINANCE_ENTRY_RESULT_CENTER_REQUIRED (400, os códigos da criação): edição que apaga o centro
 *    e excedente classificado sem o centro (M4 §4);
 *  - FINANCE_ENTRY_DUE_DATE_IMMUTABLE (409): trocar o vencimento já gravado (o banco recusa pelo trigger append-only; aqui a resposta é clara).
 */
const AppError = require('../../../../utils/AppError');
const { isMissingDueDate, clearedRequiredField, dueDateEdit, missingForExcessClassification } = require('../../domain/open-entry-required');

const dueDateRequired = (what) =>
  AppError.unprocessable(
    `Informe o vencimento: ${what} exige a data de vencimento (contas e recebíveis em 7/30/60 dias e inadimplência dependem dela).`,
    'FINANCE_ENTRY_DUE_DATE_REQUIRED',
    { field: 'dueAt' }
  );
const costCenterRequired = (msg) => AppError.badRequest(msg, 'FINANCE_ENTRY_COST_CENTER_REQUIRED', { field: 'costCenterId' });
const resultCenterRequired = (msg) => AppError.badRequest(msg, 'FINANCE_ENTRY_RESULT_CENTER_REQUIRED', { field: 'resultCenterId' });

/** Criação: lançamento a pagar ou a receber próprio precisa do vencimento. */
function assertOwnOpenEntryHasDueDate({ nature, isThirdPartyFunds, dueAt }) {
  if (isMissingDueDate({ nature, isThirdPartyFunds, dueAt })) {
    throw dueDateRequired(String(nature).toUpperCase() === 'PAYABLE' ? 'conta a pagar própria' : 'conta a receber própria');
  }
}

/** Edição (PENDING): não apaga vencimento nem centro obrigatório; o vencimento gravado não é trocado (só preenchido quando faltava). */
function assertEditKeepsRequiredFields(entry, payload) {
  const cleared = clearedRequiredField(entry, payload);
  if (cleared === 'dueAt') throw dueDateRequired('o lançamento a pagar ou a receber próprio');
  if (cleared === 'costCenterId') throw costCenterRequired('Lançamento de despesa exige o centro de custo: troque por outro centro, sem apagar.');
  if (cleared === 'resultCenterId') throw resultCenterRequired('Lançamento de receita exige o centro de resultado: troque por outro centro, sem apagar.');
  const dueEdit = payload ? dueDateEdit(entry.dueAt, payload.dueAt) : 'none';
  if (dueEdit === 'change' || dueEdit === 'clear') {
    throw AppError.conflict(
      'O vencimento já gravado não pode ser trocado (faz parte do fato do lançamento). Para outra data, cancele este lançamento e crie outro.',
      'FINANCE_ENTRY_DUE_DATE_IMMUTABLE',
      { field: 'dueAt' }
    );
  }
}

/** Classificação do excedente: receita exige centro de resultado; despesa exige centro de custo e vencimento. */
function assertExcessClassificationComplete(finalNature, options) {
  const missing = missingForExcessClassification(finalNature, options);
  if (missing.includes('resultCenterId')) throw resultCenterRequired('Classificar como receita exige o centro de resultado.');
  if (missing.includes('costCenterId')) throw costCenterRequired('Classificar como despesa exige o centro de custo.');
  if (missing.includes('dueAt')) throw dueDateRequired('o excedente classificado como despesa (vira conta a pagar própria)');
}

module.exports = { dueDateEdit, assertOwnOpenEntryHasDueDate, assertEditKeepsRequiredFields, assertExcessClassificationComplete };
