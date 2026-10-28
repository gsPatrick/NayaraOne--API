'use strict';

const { VARIABLE_TYPES } = require('./template.constants');
const { invalidInput, unknownVariable } = require('./template.errors');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const MAX_VARIABLES = 100;

/** Valida e normaliza variables_json: lista de { name, type } sem repetição. */
function normalizeVariableDefs(variables) {
  if (variables === undefined || variables === null) return [];
  if (!Array.isArray(variables) || variables.length > MAX_VARIABLES) {
    throw invalidInput(`As variáveis do template devem ser uma lista de até ${MAX_VARIABLES} itens.`);
  }
  const seen = new Set();
  return variables.map((item) => {
    const name = item && typeof item.name === 'string' ? item.name.trim() : '';
    if (!NAME_RE.test(name)) throw invalidInput('O nome de cada variável deve começar por letra e ter só letras, números e sublinhado.', { name: item && item.name });
    if (!VARIABLE_TYPES.includes(item.type)) throw invalidInput(`O tipo da variável "${name}" deve ser um de: ${VARIABLE_TYPES.join(', ')}.`, { name });
    if (seen.has(name)) throw invalidInput(`A variável "${name}" está repetida.`, { name });
    seen.add(name);
    return { name, type: item.type };
  });
}

/** Placeholders do corpo. `invalid` junta o que está entre chaves duplas mas não é nome válido e chaves duplas soltas. */
function extractPlaceholders(body) {
  const names = [];
  const invalid = [];
  PLACEHOLDER_RE.lastIndex = 0;
  const rest = String(body).replace(PLACEHOLDER_RE, (_all, inner) => {
    const name = inner.trim();
    if (NAME_RE.test(name)) names.push(name);
    else invalid.push(`{{${inner}}}`);
    return '';
  });
  if (rest.includes('{{') || rest.includes('}}')) invalid.push('{{ ou }} sem par');
  return { names: [...new Set(names)], invalid };
}

/** Recusa (422) placeholder que não está declarado em variables_json ou que está mal formado. */
function assertNoUnknownVariables(body, variables) {
  const declared = new Set((variables || []).map((v) => v.name));
  const { names, invalid } = extractPlaceholders(body);
  const unknown = [...names.filter((n) => !declared.has(n)), ...invalid];
  if (unknown.length > 0) throw unknownVariable(unknown);
}

module.exports = { normalizeVariableDefs, extractPlaceholders, assertNoUnknownVariables };
