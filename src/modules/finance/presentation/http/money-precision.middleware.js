'use strict';

/**
 * Caderno M4 §2 FIN-008 "Sem float — moeda usa numeric/decimal" e precisão até o centavo
 * (revisão 19/10, A18). Defeito: POST /finance/entries com amount 1.005 era aceito e gravado
 * 1.01 — o banco (numeric(18,2)) arredondava em silêncio. As entradas HTTP de dinheiro do
 * Financeiro passam a recusar valor com mais de 2 casas decimais (400
 * FINANCE_AMOUNT_PRECISION_INVALID), em vez de gravar um valor diferente do informado.
 * Verificação 11/11/2026 (sonda P1): "1e-3" não casava o padrão decimal, passava como "não é número, o serviço
 * valida" e o banco gravava 0,00. Texto que o JavaScript lê como número mas não é decimal simples (notação
 * científica, hexadecimal, Infinity) é recusado com 400 FINANCE_AMOUNT_FORMAT_INVALID; texto que nem número é segue
 * para a validação do serviço (que também recusa: domain/financial-entry.js#isPositiveAmount).
 * Chamadas internas que CALCULAM valores (juros, rateios, parcelas) não passam por aqui: elas
 * arredondam no próprio cálculo. O extrato importado por arquivo já recusa mais de 2 casas no
 * leitor do CSV (bank-transactions.service.js#parseStatementAmount).
 */
const AppError = require('../../../../utils/AppError');

const DECIMAL_STRING = /^[-+]?\d+(?:\.(\d+))?$/;

/** 'FORMAT' (número fora do formato decimal simples), 'PRECISION' (3ª casa significativa) ou null (aceito aqui). */
function moneyInputProblem(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6 ? null : 'PRECISION';
  }
  const text = String(value).trim();
  const m = DECIMAL_STRING.exec(text);
  if (!m) return Number.isFinite(Number(text)) && text !== '' || /^[+-]?infinity$/i.test(text) ? 'FORMAT' : null;
  return !m[1] || m[1].length <= 2 || /^0+$/.test(m[1].slice(2)) ? null : 'PRECISION';
}

/** Devolve true quando o valor tem no máximo 2 casas decimais em formato decimal simples (ou não é um número: a validação de tipo fica com o serviço). */
function hasAtMostTwoDecimals(value) {
  return moneyInputProblem(value) === null;
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}

function problemError(field, value, problem) {
  if (problem === 'FORMAT') {
    return AppError.badRequest(
      `O valor de "${field}" (${value}) não está no formato de dinheiro. Informe o valor em decimal simples, por exemplo 0.30 ou 1500.00 (sem notação científica).`,
      'FINANCE_AMOUNT_FORMAT_INVALID',
      { field, value: String(value) }
    );
  }
  return AppError.badRequest(
    `O valor de "${field}" (${value}) tem mais de 2 casas decimais. Dinheiro é registrado até o centavo: informe, por exemplo, 1.00 ou 1.01, sem arredondamento automático.`,
    'FINANCE_AMOUNT_PRECISION_INVALID',
    { field, value: String(value) }
  );
}

/** Middleware: `fields` são caminhos no corpo (ex.: 'amount', 'formalAdjustment.amount'). */
function rejectExcessDecimals(...fields) {
  return function rejectExcessDecimalsMiddleware(req, res, next) {
    for (const field of fields) {
      const value = getPath(req.body || {}, field);
      const problem = moneyInputProblem(value);
      if (problem) return next(problemError(field, value, problem));
    }
    return next();
  };
}

module.exports = { rejectExcessDecimals, hasAtMostTwoDecimals, moneyInputProblem };
