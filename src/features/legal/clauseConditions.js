'use strict';

const AppError = require('../../utils/AppError');

/**
 * clauseConditions — cláusula condicional por REGRA DECLARATIVA (Caderno, Jurídico §6:
 * "Cláusula condicional usa regras declarativas, não texto livre executável").
 *
 * A condição é um dado estruturado, nunca código: { match: 'all' | 'any', rules: [ { variable,
 * operator, value } ] }. Variáveis, operadores e valores aceitos são listas FECHADAS abaixo —
 * qualquer coisa fora delas é recusada na gravação. Não existe eval, Function, template string
 * ou interpolação em nenhum ponto: a avaliação é uma comparação direta de valores tipados.
 */

const CONTRACT_TYPES = [
  'SALE', 'SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS',
  'LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL',
  'PROPERTY_ADMIN', 'SERVICE', 'CONSTRUCTION',
];
const GUARANTEE_TYPES = ['GUARANTOR', 'INSURANCE', 'DEPOSIT', 'CAPITALIZATION_TITLE', 'OTHER', 'NONE'];

const CONDITION_VARIABLES = {
  contractType: { type: 'enum', values: CONTRACT_TYPES, label: 'Tipo de contrato' },
  guaranteeType: { type: 'enum', values: GUARANTEE_TYPES, label: 'Tipo de garantia' },
  hasGuarantor: { type: 'boolean', label: 'Possui fiador' },
  propertyPurpose: { type: 'enum', values: ['RESIDENTIAL', 'COMMERCIAL', 'SEASONAL'], label: 'Finalidade do imóvel' },
  tenantPersonType: { type: 'enum', values: ['PF', 'PJ'], label: 'Locatário/comprador pessoa física ou jurídica' },
  termMonths: { type: 'number', label: 'Prazo em meses' },
  totalValue: { type: 'number', label: 'Valor do contrato' },
};

const OPERATORS = {
  eq: { types: ['enum', 'boolean', 'number'] },
  neq: { types: ['enum', 'boolean', 'number'] },
  in: { types: ['enum'], list: true },
  not_in: { types: ['enum'], list: true },
  gt: { types: ['number'] },
  gte: { types: ['number'] },
  lt: { types: ['number'] },
  lte: { types: ['number'] },
  exists: { types: ['enum', 'boolean', 'number'], valueIsBoolean: true },
};

const MATCH_MODES = ['all', 'any'];
const MAX_RULES = 20;

function invalid(message) {
  return AppError.badRequest(message, 'LEGAL_CLAUSE_CONDITION_INVALID');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertScalarForVariable(variableName, def, value) {
  if (def.type === 'enum') {
    if (typeof value !== 'string' || !def.values.includes(value)) {
      throw invalid(`Valor inválido para "${variableName}": use um de ${def.values.join(', ')}.`);
    }
    return;
  }
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') throw invalid(`"${variableName}" exige valor verdadeiro/falso.`);
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`"${variableName}" exige um número.`);
  }
}

/**
 * validateCondition — valida e normaliza a condição. Retorna null para "sem condição" (cláusula
 * sempre incluída). Recusa chaves desconhecidas em qualquer nível, para que nenhum campo extra
 * (ex.: "expression", "script") consiga entrar disfarçado.
 */
function validateCondition(condition) {
  if (condition === undefined || condition === null) return null;
  if (!isPlainObject(condition)) {
    throw invalid('A condição deve ser um objeto estruturado { match, rules } — texto livre não é aceito.');
  }
  const extraKeys = Object.keys(condition).filter((k) => !['match', 'rules'].includes(k));
  if (extraKeys.length) throw invalid(`Campo não permitido na condição: ${extraKeys.join(', ')}.`);

  const match = condition.match === undefined ? 'all' : condition.match;
  if (!MATCH_MODES.includes(match)) throw invalid(`"match" deve ser ${MATCH_MODES.join(' ou ')}.`);

  if (!Array.isArray(condition.rules) || condition.rules.length === 0) {
    throw invalid('A condição precisa de pelo menos uma regra em "rules".');
  }
  if (condition.rules.length > MAX_RULES) throw invalid(`No máximo ${MAX_RULES} regras por condição.`);

  const rules = condition.rules.map((rule, index) => {
    if (!isPlainObject(rule)) throw invalid(`Regra ${index + 1} deve ser um objeto { variable, operator, value }.`);
    const ruleExtra = Object.keys(rule).filter((k) => !['variable', 'operator', 'value'].includes(k));
    if (ruleExtra.length) throw invalid(`Campo não permitido na regra ${index + 1}: ${ruleExtra.join(', ')}.`);

    const { variable, operator } = rule;
    const def = Object.prototype.hasOwnProperty.call(CONDITION_VARIABLES, variable) ? CONDITION_VARIABLES[variable] : null;
    if (!def) {
      throw invalid(`Variável desconhecida na regra ${index + 1}: "${variable}". Permitidas: ${Object.keys(CONDITION_VARIABLES).join(', ')}.`);
    }
    const op = Object.prototype.hasOwnProperty.call(OPERATORS, operator) ? OPERATORS[operator] : null;
    if (!op) {
      throw invalid(`Operador desconhecido na regra ${index + 1}: "${operator}". Permitidos: ${Object.keys(OPERATORS).join(', ')}.`);
    }
    if (!op.types.includes(def.type)) {
      throw invalid(`O operador "${operator}" não se aplica à variável "${variable}".`);
    }

    let value = rule.value;
    if (op.valueIsBoolean) {
      value = value === undefined ? true : value;
      if (typeof value !== 'boolean') throw invalid(`O operador "exists" aceita só verdadeiro/falso (regra ${index + 1}).`);
    } else if (op.list) {
      if (!Array.isArray(value) || value.length === 0) throw invalid(`O operador "${operator}" exige uma lista de valores (regra ${index + 1}).`);
      value.forEach((v) => assertScalarForVariable(variable, def, v));
    } else {
      assertScalarForVariable(variable, def, value);
    }
    return { variable, operator, value };
  });

  return { match, rules };
}

function referencedVariables(condition) {
  if (!condition) return [];
  return [...new Set(condition.rules.filter((r) => r.operator !== 'exists').map((r) => r.variable))];
}

/**
 * validateContext — o contexto vem do contrato (tipo, garantia, prazo...). Valores presentes
 * precisam respeitar o tipo da variável; variáveis desconhecidas são recusadas pelo mesmo
 * motivo da condição (nenhum dado livre entra na avaliação).
 */
function validateContext(context) {
  if (context === undefined || context === null) return {};
  if (!isPlainObject(context)) throw invalid('O contexto das condições deve ser um objeto { variavel: valor }.');
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    const def = Object.prototype.hasOwnProperty.call(CONDITION_VARIABLES, key) ? CONDITION_VARIABLES[key] : null;
    if (!def) throw invalid(`Variável desconhecida no contexto: "${key}".`);
    if (value === undefined || value === null) continue;
    assertScalarForVariable(key, def, value);
    out[key] = value;
  }
  return out;
}

function evaluateRule(rule, context) {
  const present = Object.prototype.hasOwnProperty.call(context, rule.variable);
  const actual = context[rule.variable];
  switch (rule.operator) {
    case 'exists': return present === rule.value;
    case 'eq': return actual === rule.value;
    case 'neq': return actual !== rule.value;
    case 'in': return rule.value.includes(actual);
    case 'not_in': return !rule.value.includes(actual);
    case 'gt': return actual > rule.value;
    case 'gte': return actual >= rule.value;
    case 'lt': return actual < rule.value;
    case 'lte': return actual <= rule.value;
    default: return false;
  }
}

/**
 * evaluateCondition — true = cláusula entra no documento. Variável referenciada (fora de
 * "exists") que não veio no contexto é ERRO, não "falso": excluir uma cláusula em silêncio por
 * falta de dado mudaria o contrato sem ninguém perceber.
 */
function evaluateCondition(condition, context) {
  if (!condition) return true;
  const missing = referencedVariables(condition).filter((v) => !Object.prototype.hasOwnProperty.call(context, v));
  if (missing.length) {
    throw AppError.badRequest(
      `Faltam dados para avaliar a condição da cláusula: ${missing.join(', ')}.`,
      'LEGAL_CLAUSE_CONDITION_CONTEXT_MISSING'
    );
  }
  const results = condition.rules.map((rule) => evaluateRule(rule, context));
  return condition.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

module.exports = {
  CONDITION_VARIABLES,
  OPERATORS: Object.keys(OPERATORS),
  validateCondition,
  validateContext,
  evaluateCondition,
  referencedVariables,
};
