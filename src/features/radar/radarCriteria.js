'use strict';

const crypto = require('node:crypto');
const AppError = require('../../utils/AppError');

/**
 * Critérios do Radar no formato do livro (Marco 3 §13: "Obrigatório, Preferência, Flexível, Exclusão"; Guia §9 "Radar scoring").
 *
 *   criteriaJson = {
 *     // OBRIGATÓRIOS — chaves planas (formato de sempre, o que o Front manda) e/ou dentro de `required`; as duas se somam:
 *     propertyType, offerType, minPrice, maxPrice, city, state, minAreaM2, maxAreaM2,
 *     required: { ...mesmas chaves },
 *     preferences: [{ code: 'NEIGHBORHOOD'|'MIN_BEDROOMS'|'MIN_SUITES'|'MIN_PARKING', value, weight? }],
 *     flexible:    [{ code: 'ATTRIBUTE', key, value, weight? } | { code: 'MAX_DISTANCE_KM', lat, lng, value, weight? }],
 *     exclusions:  [{ code: 'PROPERTY_TYPE', value } | { code: 'ATTRIBUTE', key, value }],
 *   }
 * Peso padrão 1. Obrigatório que falha ou exclusão que bate tira o imóvel do match (score 0, motivo REQUIRED_FAILED/EXCLUDED).
 */
const REQUIRED_KEYS = ['propertyType', 'offerType', 'minPrice', 'maxPrice', 'city', 'state', 'minAreaM2', 'maxAreaM2'];
const PREFERENCE_CODES = ['NEIGHBORHOOD', 'MIN_BEDROOMS', 'MIN_SUITES', 'MIN_PARKING'];
const FLEXIBLE_CODES = ['ATTRIBUTE', 'MAX_DISTANCE_KM'];
const EXCLUSION_CODES = ['PROPERTY_TYPE', 'ATTRIBUTE'];
const NUMERIC_CODES = ['MIN_BEDROOMS', 'MIN_SUITES', 'MIN_PARKING', 'MAX_DISTANCE_KM'];
const SCORING_VERSION = 'radar-scoring-v2';

const blank = (v) => v === undefined || v === null || v === '';
const invalid = (message, details) => AppError.unprocessable(message, 'RADAR_CRITERIA_INVALID', details);

function validateItem(item, index, group, codes) {
  const where = `${group}[${index}]`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`O critério ${where} precisa ser um objeto com "code".`, { field: where });
  const code = String(item.code || '').toUpperCase();
  if (!codes.includes(code)) throw invalid(`O critério ${where} tem código "${item.code || ''}" fora da lista aceita (${codes.join(', ')}).`, { field: `${where}.code` });
  if (blank(item.value)) throw invalid(`O critério ${where} (${code}) precisa de "value".`, { field: `${where}.value` });
  if (NUMERIC_CODES.includes(code) && (!Number.isFinite(Number(item.value)) || Number(item.value) < 0)) {
    throw invalid(`O critério ${where} (${code}) precisa de "value" numérico, zero ou maior.`, { field: `${where}.value` });
  }
  if (code === 'ATTRIBUTE' && (typeof item.key !== 'string' || !item.key.trim())) throw invalid(`O critério ${where} (ATTRIBUTE) precisa de "key".`, { field: `${where}.key` });
  if (code === 'MAX_DISTANCE_KM') {
    for (const k of ['lat', 'lng']) {
      if (blank(item[k]) || !Number.isFinite(Number(item[k]))) throw invalid(`O critério ${where} (MAX_DISTANCE_KM) precisa de "${k}" numérico.`, { field: `${where}.${k}` });
    }
  }
  if (item.weight !== undefined && (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight <= 0)) {
    throw invalid(`O peso do critério ${where} precisa ser um número maior que zero.`, { field: `${where}.weight` });
  }
}

/** Recusa (422 RADAR_CRITERIA_INVALID) critério fora do formato. Chamado na criação e na edição do radar. */
function validateCriteria(criteriaJson) {
  if (!criteriaJson || typeof criteriaJson !== 'object' || Array.isArray(criteriaJson)) throw invalid('"criteriaJson" precisa ser um objeto.', { field: 'criteriaJson' });
  if (criteriaJson.required !== undefined && (typeof criteriaJson.required !== 'object' || Array.isArray(criteriaJson.required) || criteriaJson.required === null)) {
    throw invalid('"required" precisa ser um objeto com os critérios obrigatórios.', { field: 'required' });
  }
  for (const [group, codes] of [['preferences', PREFERENCE_CODES], ['flexible', FLEXIBLE_CODES], ['exclusions', EXCLUSION_CODES]]) {
    const list = criteriaJson[group];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw invalid(`"${group}" precisa ser uma lista.`, { field: group });
    list.forEach((item, i) => validateItem(item, i, group, codes));
  }
  const required = requiredOf(criteriaJson);
  for (const k of ['minPrice', 'maxPrice', 'minAreaM2', 'maxAreaM2']) {
    if (!blank(required[k]) && !Number.isFinite(Number(required[k]))) throw invalid(`O critério obrigatório "${k}" precisa ser numérico.`, { field: k });
  }
}

/** Obrigatórios: as chaves planas de sempre mescladas com `required` (que prevalece). */
function requiredOf(criteriaJson) {
  const source = criteriaJson || {};
  const out = {};
  for (const k of REQUIRED_KEYS) if (!blank(source[k])) out[k] = source[k];
  const nested = source.required && typeof source.required === 'object' ? source.required : {};
  for (const k of REQUIRED_KEYS) if (!blank(nested[k])) out[k] = nested[k];
  return out;
}

const listOf = (criteriaJson, group) => (Array.isArray(criteriaJson && criteriaJson[group]) ? criteriaJson[group] : [])
  .map((item) => ({ ...item, code: String(item.code || '').toUpperCase(), weight: item.weight === undefined ? 1 : Number(item.weight) }));

function normalizeCriteria(criteriaJson) {
  return {
    required: requiredOf(criteriaJson),
    preferences: listOf(criteriaJson, 'preferences'),
    flexible: listOf(criteriaJson, 'flexible'),
    exclusions: listOf(criteriaJson, 'exclusions'),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

/** Impressão digital dos critérios (SHA-256 do JSON canônico normalizado): idempotência do match gravado (Guia §9). */
function criteriaFingerprint(criteriaJson) {
  return crypto.createHash('sha256').update(canonical(normalizeCriteria(criteriaJson))).digest('hex');
}

module.exports = { validateCriteria, normalizeCriteria, criteriaFingerprint, SCORING_VERSION, REQUIRED_KEYS, PREFERENCE_CODES, FLEXIBLE_CODES, EXCLUSION_CODES };
