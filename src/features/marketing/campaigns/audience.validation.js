'use strict';

const { AUDIENCE_KINDS } = require('./campaigns.constants');
const { validation } = require('./campaigns.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Campos que cada tipo de público aceita. Só entram dados que o cadastro já tem; documento, renda, saúde e afins nunca são filtro
 * (a lista de campos proibidos configurável é da M9-D433). `companyId` é aceito só para ser conferido: se não for a empresa da
 * campanha, 422 MKT_AUDIENCE_CROSS_COMPANY.
 */
const FILTER_KEYS = Object.freeze({
  PERSON_LIST: ['personIds'],
  SEGMENT: ['roles', 'opportunityStages', 'temperatures', 'personType'],
  RADAR_MATCH: ['propertyType', 'offerType', 'city', 'state', 'radarIds'],
});
const LIST_KEYS = new Set(['roles', 'opportunityStages', 'temperatures']);

function stringList(value, key) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.some((v) => typeof v !== 'string' || !v.trim() || v.length > 64)) {
    throw validation(`O filtro "${key}" deve ter ao menos um valor de texto.`, { field: key });
  }
  return [...new Set(list.map((v) => v.trim().toUpperCase()))];
}

function uuidList(value, key) {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) {
    throw validation(`O filtro "${key}" deve ser uma lista de identificadores válidos.`, { field: key });
  }
  return [...new Set(value.map((v) => v.toLowerCase()))].sort();
}

function parseFilter(kind, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw validation('O filtro do público deve ser um objeto.', { field: 'filter' });
  const { companyId, ...rest } = raw;
  const allowed = FILTER_KEYS[kind];
  const unknown = Object.keys(rest).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw validation(`O filtro do público tem campo não permitido: ${unknown.join(', ')}.`, { field: 'filter', unknown });
  const filter = {};
  for (const key of Object.keys(rest)) {
    if (rest[key] === undefined || rest[key] === null) continue;
    if (key === 'personIds' || key === 'radarIds') filter[key] = uuidList(rest[key], key);
    else if (LIST_KEYS.has(key)) filter[key] = stringList(rest[key], key);
    else if (typeof rest[key] === 'string' && rest[key].trim()) filter[key] = key === 'personType' || key === 'propertyType' || key === 'offerType' || key === 'state' ? rest[key].trim().toUpperCase() : rest[key].trim();
    else throw validation(`O filtro "${key}" deve ser um texto.`, { field: key });
  }
  if (kind === 'PERSON_LIST' && !filter.personIds) throw validation('A lista de pessoas precisa de "personIds".', { field: 'filter' });
  if (kind === 'SEGMENT' && Object.keys(filter).length === 0) throw validation('O público por segmento precisa de ao menos um filtro.', { field: 'filter' });
  return { filter, claimedCompanyId: companyId === undefined || companyId === null ? null : String(companyId) };
}

function parseAudiences(raw) {
  if (!Array.isArray(raw)) throw validation('O campo "audiences" deve ser uma lista.', { field: 'audiences' });
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object') throw validation(`A audiência ${index + 1} é inválida.`, { field: 'audiences' });
    const kind = typeof item.kind === 'string' ? item.kind.trim().toUpperCase() : '';
    if (!AUDIENCE_KINDS.includes(kind)) throw validation(`O tipo da audiência ${index + 1} deve ser um de: ${AUDIENCE_KINDS.join(', ')}.`, { field: 'audiences', allowed: AUDIENCE_KINDS });
    const purpose = typeof item.purpose === 'string' ? item.purpose.trim() : '';
    if (!purpose || purpose.length > 40) throw validation(`Informe a finalidade da audiência ${index + 1} (até 40 caracteres).`, { field: 'audiences' });
    return { kind, purpose, ...parseFilter(kind, item.filter) };
  });
}

module.exports = { parseAudiences, FILTER_KEYS };
