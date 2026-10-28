'use strict';

/**
 * M9-D603 (3.1) — campos obrigatórios da definição de métrica: os 13 do livro §13 mais `value_nature` e
 * `criticality` (15 itens). Aqui só existe validação de forma; existência de fórmula, de read model e testes
 * ficam no serviço de publicação.
 *
 * Mapa campo do livro -> chaves de entrada. Vigência: `validFrom` é obrigatório; o fim (`valid_until`) é
 * fechado pela publicação da próxima versão (M9-D604), por isso informar `validUntil` é recusado.
 */
const AppError = require('../../../utils/AppError');
const { UNITS, VALUE_NATURES, DOMAINS } = require('../metricStore.service');

const CRITICALITIES = ['CRITICAL', 'NORMAL'];
const CODE_RE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const READ_MODEL_RE = /^rm_[a-z][a-z0-9_]*$/;
const DOMAIN_BY_PREFIX = {
  fin: 'FINANCE', crm: 'CRM', radar: 'CRM', prop: 'PROPERTIES', rent: 'RENTAL', obra: 'CONSTRUCTION', inv: 'INVENTORY',
  legal: 'LEGAL', cor: 'CORRESPONDENT', mkt: 'MARKETING', sup: 'SUPPORT', tec: 'TECH_AI',
};

const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;

// [nome no livro (snake), chave(s) de entrada, teste de presença]
const REQUIRED = [
  ['metric_code', 'metricCode', isText],
  ['name', 'name', isText],
  ['description', 'description', isText],
  ['formula_id', 'formulaId', isText],
  ['formula_semantic', 'formulaSemantic', isText],
  ['source_read_model', 'sourceReadModel', isText],
  ['dimensions', 'dimensions', Array.isArray],
  ['filters', 'filters', isObject],
  ['unit', 'unit', isText],
  ['owner', 'ownerRole', isText],
  ['refresh_policy', 'refreshPolicy', isObject],
  ['version', 'version', isPositiveInt],
  ['valid_from/until', 'validFrom', isText],
  ['quality_rule', 'qualityRule', isObject],
  ['value_nature', 'valueNature', isText],
  ['criticality', 'criticality', isText],
];

/** Campos que faltam, com o nome do livro. 422 ANALYTICS_METRIC_INCOMPLETE quando houver. */
function findMissingFields(input) {
  const src = input || {};
  return REQUIRED.filter(([, key, ok]) => !ok(src[key])).map(([name]) => name);
}

function assertComplete(input) {
  const missing = findMissingFields(input);
  if (missing.length) {
    throw AppError.unprocessable(`Faltam campos obrigatórios: ${missing.join(', ')}.`, 'ANALYTICS_METRIC_INCOMPLETE', { campos: missing });
  }
}

const bad = (message) => AppError.badRequest(message, 'ANALYTICS_METRIC_INVALID');

function validateRefreshPolicy(rp) {
  if (!['EVENT', 'SCHEDULE'].includes(rp.mode)) throw bad('A política de atualização deve ter modo EVENT ou SCHEDULE.');
  if (rp.mode === 'SCHEDULE' && !isText(rp.cron)) throw bad('A política SCHEDULE exige o cron.');
  if (!isPositiveInt(rp.maxStalenessMinutes)) throw bad('A política de atualização exige maxStalenessMinutes (minutos inteiros, maior que zero).');
}

/** Regra de qualidade válida: objeto com `referenceReport` (relatório de comparação, M9-D708) e tipos corretos nas chaves conhecidas. */
function validateQualityRule(rule) {
  if (!isText(rule.referenceReport)) throw bad('A regra de qualidade exige referenceReport (o relatório de comparação do indicador).');
  if (rule.maxStalenessMinutes != null && !isPositiveInt(rule.maxStalenessMinutes)) throw bad('maxStalenessMinutes da regra de qualidade deve ser inteiro maior que zero.');
  if (rule.requiredFields != null && !(Array.isArray(rule.requiredFields) && rule.requiredFields.every(isText))) {
    throw bad('requiredFields da regra de qualidade deve ser uma lista de textos.');
  }
  if (rule.allowNull != null && typeof rule.allowNull !== 'boolean') throw bad('allowNull da regra de qualidade deve ser verdadeiro ou falso.');
}

/** Domínio informado ou derivado do prefixo do código (fin -> FINANCE ...). */
function resolveDomain(input) {
  const domain = input.domain || DOMAIN_BY_PREFIX[String(input.metricCode).split('.')[0]];
  if (!DOMAINS.includes(domain)) throw bad(`Domínio inválido. Informe um destes: ${DOMAINS.join(', ')}.`);
  return domain;
}

/** Validação de forma (depois de `assertComplete`). Devolve o domínio resolvido. */
function validateShape(input) {
  if (!CODE_RE.test(input.metricCode)) throw bad('O código da métrica deve seguir o formato dominio.nome_em_snake (minúsculas, números e "_").');
  if (!UNITS.includes(input.unit)) throw bad(`Unidade inválida. Valores aceitos: ${UNITS.join(', ')}.`);
  if (!VALUE_NATURES.includes(input.valueNature)) throw bad(`Natureza do valor inválida. Valores aceitos: ${VALUE_NATURES.join(', ')}.`);
  if (!CRITICALITIES.includes(input.criticality)) throw bad('Criticidade inválida. Informe CRITICAL ou NORMAL.');
  if (!DATE_RE.test(input.validFrom) || Number.isNaN(Date.parse(`${input.validFrom}T00:00:00Z`))) throw bad('O início da vigência deve ser uma data AAAA-MM-DD.');
  if (input.validUntil != null) throw bad('O fim da vigência é fechado pela publicação da próxima versão; não informe validUntil.');
  if (!READ_MODEL_RE.test(input.sourceReadModel)) throw bad('O read model de origem deve ter o formato rm_nome_em_snake.');
  if (!input.dimensions.every(isText)) throw bad('dimensions deve ser uma lista de textos.');
  validateRefreshPolicy(input.refreshPolicy);
  validateQualityRule(input.qualityRule);
  return resolveDomain(input);
}

module.exports = { REQUIRED, CRITICALITIES, findMissingFields, assertComplete, validateShape };
