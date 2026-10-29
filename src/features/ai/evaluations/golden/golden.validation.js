'use strict';

const E = require('./golden.errors');
const K = require('./golden.constants');
const { CATEGORIES } = require('../evaluations.constants');
const { normalizeCode } = require('../../agents/agents.validation');
const { redactForAi } = require('../../../../shared/redaction');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/** Tipos de dado pessoal ou segredo achados em qualquer texto do valor (percorre objetos e listas). */
function piiTypesIn(value, found = new Set()) {
  if (typeof value === 'string') redactForAi(value, { placeholderFor: (tipo) => { found.add(tipo); return `[${tipo}]`; } });
  else if (Array.isArray(value)) value.forEach((v) => piiTypesIn(v, found));
  else if (isObject(value)) Object.values(value).forEach((v) => piiTypesIn(v, found));
  return found;
}

function checkKeys(obj, allowed, label) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw E.invalid(`Campo não aceito em ${label}: ${extra.join(', ')}.`, { permitidos: allowed });
}

function checkStrings(list, label) {
  if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !s.trim() || s.length > 200)) throw E.invalid(`${label} deve ser uma lista de textos de até 200 caracteres.`);
}

function checkExpected(category, expected) {
  checkKeys(expected, K.EXPECTED_KEYS[category], 'expected');
  if (expected.contains !== undefined) checkStrings(expected.contains, 'expected.contains');
  if (expected.tools !== undefined) checkStrings(expected.tools, 'expected.tools');
  if (expected.tool !== undefined && (typeof expected.tool !== 'string' || !expected.tool.trim())) throw E.invalid('expected.tool deve ser o nome de uma ferramenta.');
  for (const flag of ['insufficient', 'blocked', 'detected']) {
    if (expected[flag] !== undefined && typeof expected[flag] !== 'boolean') throw E.invalid(`expected.${flag} deve ser verdadeiro ou falso.`);
  }
  for (const num of ['maxCostMicros', 'maxLatencyMs']) {
    if (expected[num] !== undefined && !isNonNegInt(expected[num])) throw E.invalid(`expected.${num} deve ser um inteiro não negativo.`);
  }
}

function checkFixtures(category, fixtures) {
  checkKeys(fixtures, K.FIXTURE_KEYS[category], 'fixtures');
  if (fixtures.sources !== undefined && (!Array.isArray(fixtures.sources) || fixtures.sources.some((s) => !isObject(s)))) throw E.invalid('fixtures.sources deve ser uma lista de fontes.');
  if (fixtures.actorPermissions !== undefined) checkStrings(fixtures.actorPermissions, 'fixtures.actorPermissions');
  if (fixtures.toolName !== undefined && (typeof fixtures.toolName !== 'string' || !fixtures.toolName.trim())) throw E.invalid('fixtures.toolName deve ser o nome de uma ferramenta.');
}

/** Corpo de um caso: { caseKey, category, input, fixtures?, expected?, mustNot? }. Dado pessoal ou segredo é recusado (D027). */
function parseCaseBody(body, { requireKey = true } = {}) {
  if (!isObject(body)) throw E.invalid('Corpo do caso ausente.');
  const category = typeof body.category === 'string' ? body.category.trim().toUpperCase() : '';
  if (!CATEGORIES.includes(category)) throw E.invalid('Categoria inválida.', { permitidas: CATEGORIES });
  const caseKey = typeof body.caseKey === 'string' ? body.caseKey.trim() : '';
  if (requireKey && !K.KEY_RE.test(caseKey)) throw E.invalid('A chave do caso deve ter letras minúsculas, números, _ . : ou -, até 80 caracteres.');
  const input = typeof body.input === 'string' ? body.input : '';
  if (!input.trim() || input.length > K.INPUT_MAX) throw E.invalid(`A entrada do caso é obrigatória e tem até ${K.INPUT_MAX} caracteres.`);
  const fixtures = body.fixtures === undefined ? {} : body.fixtures;
  const expected = body.expected === undefined ? {} : body.expected;
  const mustNot = body.mustNot === undefined ? [] : body.mustNot;
  if (!isObject(fixtures) || !isObject(expected)) throw E.invalid('fixtures e expected devem ser objetos.');
  checkFixtures(category, fixtures);
  checkExpected(category, expected);
  checkStrings(mustNot, 'mustNot');
  const found = piiTypesIn({ input, fixtures, expected, mustNot });
  if (found.size) throw E.pii({ tipos: [...found].sort() });
  return { caseKey, category, input, fixtures, expected, mustNot };
}

function parseAgentCode(raw) {
  const code = normalizeCode(raw);
  if (!code) throw E.invalid('Informe o código do agente (letras maiúsculas, números e _).');
  return code;
}

module.exports = { parseCaseBody, parseAgentCode, piiTypesIn, isObject };
