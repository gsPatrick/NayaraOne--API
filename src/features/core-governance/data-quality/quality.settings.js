'use strict';

const { RULE_CATALOG, CODES } = require('./quality.catalog.constants');
const { SEVERITIES } = require('./quality.constants');

/**
 * Parâmetros da qualidade de cadastro (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.dados.qualidade.pesos: peso de cada regra (REGRA=peso). Padrão = pesos do item 3.1 da M9-D806.
 *  - governanca.dados.qualidade.severidades: severidade de cada regra (REGRA=LOW|MEDIUM|HIGH|CRITICAL). Padrão = item 3.1.
 *  - governanca.dados.qualidade.regras_desativadas: regras fora do cálculo (NENHUMA = todas ligadas).
 *  - governanca.dados.qualidade.endereco_campos: campos do endereço que o "endereço completo" exige.
 *  - governanca.dados.qualidade.midia_minima: mínimo de fotos/mídias do imóvel (padrão 1).
 *  - governanca.dados.qualidade.categorias_qualificacao: categorias de fornecedor que exigem qualificação vigente (* = todas; hoje as compras já exigem de todos).
 *  - governanca.dados.qualidade.severidade_revisao: a partir de qual severidade a issue vai à fila de revisão do steward (padrão CRITICAL).
 *  - governanca.dados.qualidade.varredura_hora: hora da varredura noturna, horário de Brasília (padrão 3).
 *  - governanca.dados.qualidade.lista_tamanho_padrao: itens por página de GET /data-quality (padrão 50).
 */
const WEIGHTS_KEY = 'governanca.dados.qualidade.pesos';
const SEVERITIES_KEY = 'governanca.dados.qualidade.severidades';
const DISABLED_KEY = 'governanca.dados.qualidade.regras_desativadas';
const ADDRESS_FIELDS_KEY = 'governanca.dados.qualidade.endereco_campos';
const MEDIA_MIN_KEY = 'governanca.dados.qualidade.midia_minima';
const QUALIFICATION_CATEGORIES_KEY = 'governanca.dados.qualidade.categorias_qualificacao';
const REVIEW_SEVERITY_KEY = 'governanca.dados.qualidade.severidade_revisao';
const SCAN_HOUR_KEY = 'governanca.dados.qualidade.varredura_hora';
const PAGE_SIZE_KEY = 'governanca.dados.qualidade.lista_tamanho_padrao';

const ADDRESS_FIELDS = Object.freeze(['zip_code', 'street', 'number', 'neighborhood', 'city', 'state']);
const NONE = 'NENHUMA';
const DEFAULT_WEIGHTS = RULE_CATALOG.map((item) => `${item.code}=${item.weight}`).join(', ');
const DEFAULT_SEVERITIES = RULE_CATALOG.map((item) => `${item.code}=${item.severity}`).join(', ');
const DEFAULT_ADDRESS_FIELDS = ADDRESS_FIELDS.join(', ');

const splitList = (text) => String(typeof text === 'string' ? text : '').split(',').map((v) => v.trim()).filter(Boolean);

/** "A=1, B=2" -> { A: '1', B: '2' } só para regras conhecidas. */
function parsePairs(text) {
  const out = {};
  splitList(text).forEach((pair) => {
    const [code, ...rest] = pair.split('=');
    if (CODES.includes(code.trim()) && rest.length) out[code.trim()] = rest.join('=').trim();
  });
  return out;
}

function parseWeights(text) {
  const out = {};
  Object.entries(parsePairs(text)).forEach(([code, raw]) => { if (/^\d{1,3}$/.test(raw)) out[code] = Number(raw); });
  return out;
}

function parseSeverities(text) {
  const out = {};
  Object.entries(parsePairs(text)).forEach(([code, raw]) => { if (SEVERITIES.includes(raw.toUpperCase())) out[code] = raw.toUpperCase(); });
  return out;
}

const parseDisabled = (text) => splitList(text).map((v) => v.toUpperCase()).filter((v) => CODES.includes(v));
const parseAddressFields = (text) => { const list = splitList(text).filter((v) => ADDRESS_FIELDS.includes(v)); return list.length ? list : [...ADDRESS_FIELDS]; };

/** "*" = todas as categorias; senão a lista em maiúsculas. */
function parseCategories(text) {
  const list = splitList(text).map((v) => v.toUpperCase());
  return list.includes('*') || !list.length ? '*' : list;
}

function validatePairs(parser, label) {
  return (key, value) => {
    const { govError } = require('../governance.errors');
    const pairs = splitList(value);
    const parsed = parser(value);
    const bad = pairs.filter((pair) => !(pair.split('=')[0].trim() in parsed));
    if (!pairs.length || bad.length) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar REGRA=${label} separados por vírgula, entre: ${CODES.join(', ')}.`, { key, invalid: bad });
  };
}

function validateCodes(key, value) {
  const { govError } = require('../governance.errors');
  const items = splitList(value).map((v) => v.toUpperCase());
  const bad = items.filter((v) => v !== NONE && !CODES.includes(v));
  if (!items.length || bad.length) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser ${NONE} ou listar regras separadas por vírgula, entre: ${CODES.join(', ')}.`, { key, invalid: bad });
}

function validateAddressFields(key, value) {
  const { govError } = require('../governance.errors');
  const items = splitList(value);
  const bad = items.filter((v) => !ADDRESS_FIELDS.includes(v));
  if (!items.length || bad.length) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar campos do endereço entre: ${ADDRESS_FIELDS.join(', ')}.`, { key, invalid: bad });
}

const QUALITY_SETTING_DEFAULTS = Object.freeze({
  [WEIGHTS_KEY]: DEFAULT_WEIGHTS, [SEVERITIES_KEY]: DEFAULT_SEVERITIES, [DISABLED_KEY]: NONE, [ADDRESS_FIELDS_KEY]: DEFAULT_ADDRESS_FIELDS, [MEDIA_MIN_KEY]: 1,
  [QUALIFICATION_CATEGORIES_KEY]: '*', [REVIEW_SEVERITY_KEY]: 'CRITICAL', [SCAN_HOUR_KEY]: 3, [PAGE_SIZE_KEY]: 50,
});
const QUALITY_SETTINGS_SCHEMA = {
  [WEIGHTS_KEY]: { type: 'string', validate: validatePairs(parseWeights, 'peso (0 a 999)') },
  [SEVERITIES_KEY]: { type: 'string', validate: validatePairs(parseSeverities, `severidade (${SEVERITIES.join(', ')})`) },
  [DISABLED_KEY]: { type: 'string', validate: validateCodes },
  [ADDRESS_FIELDS_KEY]: { type: 'string', validate: validateAddressFields },
  [MEDIA_MIN_KEY]: { type: 'integer', min: 0, max: 100 },
  [QUALIFICATION_CATEGORIES_KEY]: { type: 'string' },
  [REVIEW_SEVERITY_KEY]: { type: 'string', enum: [...SEVERITIES] },
  [SCAN_HOUR_KEY]: { type: 'integer', min: 0, max: 23 },
  [PAGE_SIZE_KEY]: { type: 'integer', min: 1, max: 200 },
};

module.exports = {
  WEIGHTS_KEY, SEVERITIES_KEY, DISABLED_KEY, ADDRESS_FIELDS_KEY, MEDIA_MIN_KEY, QUALIFICATION_CATEGORIES_KEY, REVIEW_SEVERITY_KEY, SCAN_HOUR_KEY, PAGE_SIZE_KEY, ADDRESS_FIELDS,
  QUALITY_SETTING_DEFAULTS, QUALITY_SETTINGS_SCHEMA, parseWeights, parseSeverities, parseDisabled, parseAddressFields, parseCategories,
};
