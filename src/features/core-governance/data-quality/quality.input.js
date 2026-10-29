'use strict';

const { DOMAIN_BY_ENTITY, ENTITY_TYPES } = require('./merge.constants');
const { SEVERITIES, ISSUE_STATUS } = require('./quality.constants');
const errors = require('./quality.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_OF_DOMAIN = Object.freeze(Object.fromEntries(Object.entries(DOMAIN_BY_ENTITY).map(([entity, domain]) => [domain, entity])));

const text = (value) => (typeof value === 'string' ? value.trim() : value);

/** Filtros de GET /data-quality (M9-D806 §3.4); qualquer valor fora do conjunto devolve 400 GOV_DQ_FILTER_INVALID. */
function parseQuery(query = {}, defaultPageSize = 50) {
  const out = {};
  const given = (key) => query[key] !== undefined && query[key] !== '';
  if (given('domain')) {
    out.entityType = ENTITY_OF_DOMAIN[text(query.domain).toUpperCase()];
    if (!out.entityType) throw errors.filterInvalid({ filter: 'domain' });
  }
  if (given('entityType')) {
    const value = String(text(query.entityType)).toUpperCase();
    if (!ENTITY_TYPES.includes(value) || (out.entityType && out.entityType !== value)) throw errors.filterInvalid({ filter: 'entityType' });
    out.entityType = value;
  }
  if (given('severity')) {
    out.severity = String(text(query.severity)).toUpperCase();
    if (!SEVERITIES.includes(out.severity)) throw errors.filterInvalid({ filter: 'severity' });
  }
  if (given('status')) {
    out.status = String(text(query.status)).toUpperCase();
    if (!Object.values(ISSUE_STATUS).includes(out.status)) throw errors.filterInvalid({ filter: 'status' });
  }
  if (given('stewardId')) {
    out.stewardId = String(text(query.stewardId)).toLowerCase();
    if (!UUID.test(out.stewardId)) throw errors.filterInvalid({ filter: 'stewardId' });
  }
  const intOf = (key, min, max, fallback) => {
    if (!given(key)) return fallback;
    const value = Number(query[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw errors.filterInvalid({ filter: key });
    return value;
  };
  out.page = intOf('page', 1, 1000000, 1);
  out.pageSize = intOf('pageSize', 1, 200, defaultPageSize);
  out.issueFiltered = Boolean(out.severity || out.status || out.stewardId);
  return out;
}

module.exports = { parseQuery, ENTITY_OF_DOMAIN };
