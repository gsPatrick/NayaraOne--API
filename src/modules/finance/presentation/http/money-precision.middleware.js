'use strict';

/**
 * Caderno M4 §2 FIN-008 "Sem float — moeda usa numeric/decimal" e precisão até o centavo
 * (revisão 19/10, A18). Defeito: POST /finance/entries com amount 1.005 era aceito e gravado
 * 1.01 — o banco (numeric(18,2)) arredondava em silêncio. As entradas HTTP de dinheiro do
 * Financeiro passam a recusar valor com mais de 2 casas decimais (400
 * FINANCE_AMOUNT_PRECISION_INVALID), em vez de gravar um valor diferente do informado.
 * Chamadas internas que CALCULAM valores (juros, rateios, parcelas) não passam por aqui: elas
 * arredondam no próprio cálculo. O extrato importado por arquivo já recusa mais de 2 casas no
 * leitor do CSV (bank-transactions.service.js#parseStatementAmount).
 */
const AppError = require('../../../../utils/AppError');

const DECIMAL_STRING = /^[-+]?\d+(?:\.(\d+))?$/;

/** Devolve true quando o valor tem no máximo 2 casas decimais (ou não é um número: a validação de tipo fica com o serviço). */
function hasAtMostTwoDecimals(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return true;
    return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
  }
  const text = String(value).trim();
  const m = DECIMAL_STRING.exec(text);
  if (!m) return true;
  return !m[1] || m[1].length <= 2 || /^0+$/.test(m[1].slice(2));
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), obj);
}

/** Middleware: `fields` são caminhos no corpo (ex.: 'amount', 'formalAdjustment.amount'). */
function rejectExcessDecimals(...fields) {
  return function rejectExcessDecimalsMiddleware(req, res, next) {
    for (const field of fields) {
      const value = getPath(req.body || {}, field);
      if (!hasAtMostTwoDecimals(value)) {
        return next(
          AppError.badRequest(
            `O valor de "${field}" (${value}) tem mais de 2 casas decimais. Dinheiro é registrado até o centavo: informe, por exemplo, 1.00 ou 1.01, sem arredondamento automático.`,
            'FINANCE_AMOUNT_PRECISION_INVALID',
            { field, value: String(value) }
          )
        );
      }
    }
    return next();
  };
}

module.exports = { rejectExcessDecimals, hasAtMostTwoDecimals };
