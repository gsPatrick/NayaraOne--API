'use strict';

const { hashPiiValue } = require('../../people/personDocumentFormat.service');
const n = require('./compare.normalize');

const RULES = Object.freeze(['EXACT', 'MONEY', 'DATE', 'NUMERIC', 'ENUM_MAP', 'IGNORE']);
const MONEY_UNITS = Object.freeze(['CENTS', 'DECIMAL']);
const RESULT = Object.freeze({ MATCH: 'MATCH', ALLOWED: 'DIFF_ALLOWED', BLOCKER: 'DIFF_BLOCKER' });

/** Resumo do valor normalizado (HMAC com o segredo de PII): o resultado guarda isto, nunca o valor em claro. */
const hashOf = (field, normalized) => hashPiiValue(`${field}\u001f${normalized === null ? '\u0000' : normalized}`);

const enumValue = (value) => n.text(value);

/**
 * Compara um campo (M9-D903 §3.3). `rule` = { field, rule, tolerance, enumMap, options: { oldUnit, newUnit } }; `ctx` = { timeZone }. Devolve
 * { result, oldNormalized, newNormalized } ou null para IGNORE. DIFF_ALLOWED só no ENUM_MAP (status antigo mapeado para o novo); dinheiro compara em centavos exatos (tolerância 0).
 */
function compareField(rule, oldValue, newValue, ctx) {
  const options = rule.options || {};
  let left; let right; let equal;
  switch (rule.rule) {
    case 'IGNORE': return null;
    case 'EXACT': left = n.text(oldValue); right = n.text(newValue); equal = left === right; break;
    case 'MONEY': left = n.cents(oldValue, options.oldUnit); right = n.cents(newValue, options.newUnit); equal = left === right; break;
    case 'DATE': left = n.civilDay(oldValue, ctx.timeZone); right = n.civilDay(newValue, ctx.timeZone); equal = left === right; break;
    case 'NUMERIC': left = n.numeric(oldValue); right = n.numeric(newValue); equal = left === right || (left !== null && right !== null && n.withinTolerance(left, right, rule.tolerance)); break;
    case 'ENUM_MAP': {
      left = enumValue(oldValue); right = enumValue(newValue);
      const mapped = left !== null && rule.enumMap && Object.prototype.hasOwnProperty.call(rule.enumMap, left) ? enumValue(rule.enumMap[left]) : undefined;
      if (left === right) equal = true;
      else if (mapped !== undefined && mapped === right) return { result: RESULT.ALLOWED, oldNormalized: left, newNormalized: right };
      else equal = false;
      break;
    }
    default: throw new Error(`Regra de comparação desconhecida: ${rule.rule}.`);
  }
  return { result: equal ? RESULT.MATCH : RESULT.BLOCKER, oldNormalized: left, newNormalized: right };
}

module.exports = { RULES, MONEY_UNITS, RESULT, compareField, hashOf };
