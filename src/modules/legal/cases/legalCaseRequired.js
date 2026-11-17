'use strict';

const AppError = require('../../../utils/AppError');

/**
 * Risco e valor estimado do processo são obrigatórios (Caderno M5:244: "Processo tem número, órgão, classe,
 * status, partes, valor, risco e responsável"; o valor é a estimativa processual, M5:250).
 *
 * - Na criação os dois precisam vir preenchidos.
 * - Na edição nenhum dos dois pode ser apagado (null ou texto vazio); omitir o campo mantém o valor gravado.
 * - Valor 0 é aceito: o processo consultivo não tem valor em disputa (DI-BI2-1).
 *
 * Só presença: o formato (lista de riscos, número ≥ 0) continua em `readCaseDetails` (legal-case.service.js).
 */

const isBlank = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

const RISK_REQUIRED_TEXT = 'Informe o risco do processo (baixo, médio, alto ou crítico): ele é obrigatório e não pode ser apagado.';
const AMOUNT_REQUIRED_TEXT = 'Informe o valor estimado do processo (use 0 quando não houver valor em disputa): ele é obrigatório e não pode ser apagado.';

function riskRequired() {
  return AppError.unprocessable(RISK_REQUIRED_TEXT, 'LEGAL_CASE_RISK_REQUIRED', { field: 'riskLevel' });
}

function amountRequired() {
  return AppError.unprocessable(AMOUNT_REQUIRED_TEXT, 'LEGAL_CASE_ESTIMATED_AMOUNT_REQUIRED', { field: 'estimatedAmount' });
}

/** Criação: os dois campos precisam vir no payload. */
function assertRiskAndValueOnCreate(payload) {
  const body = payload || {};
  if (isBlank(body.riskLevel)) throw riskRequired();
  if (isBlank(body.estimatedAmount)) throw amountRequired();
}

/** Edição: o campo pode faltar (não muda), mas nunca vir vazio ou null. */
function assertRiskAndValueKept(payload) {
  const body = payload || {};
  if (body.riskLevel !== undefined && isBlank(body.riskLevel)) throw riskRequired();
  if (body.estimatedAmount !== undefined && isBlank(body.estimatedAmount)) throw amountRequired();
}

module.exports = { assertRiskAndValueOnCreate, assertRiskAndValueKept };
