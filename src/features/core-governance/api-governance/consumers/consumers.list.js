'use strict';

const { select, COLUMNS } = require('./consumers.repository');
const E = require('./consumers.errors');

const KINDS = Object.freeze(['APP', 'PROVIDER', 'PARTNER', 'INTERNAL']);
const STATUSES = Object.freeze(['ACTIVE', 'SUSPENDED', 'RETIRED']);

/** Lê os filtros do GET /api-governance/consumers; valor inválido é 400 (nunca ignorado em silêncio). */
function readFilters(query) {
  const filters = {};
  if (query.kind !== undefined) { if (!KINDS.includes(query.kind)) throw E.filterInvalid('kind', KINDS); filters.kind = query.kind; }
  if (query.status !== undefined) { if (!STATUSES.includes(query.status)) throw E.filterInvalid('status', STATUSES); filters.status = query.status; }
  if (query.apiVersion !== undefined) {
    if (!/^\d{1,4}$/.test(String(query.apiVersion)) || Number(query.apiVersion) < 1) throw E.filterInvalid('apiVersion', ['inteiro >= 1']);
    filters.apiVersion = Number(query.apiVersion);
  }
  if (query.usingDeprecated !== undefined) {
    if (!['true', 'false'].includes(String(query.usingDeprecated))) throw E.filterInvalid('usingDeprecated', ['true', 'false']);
    filters.usingDeprecated = String(query.usingDeprecated) === 'true';
  }
  return filters;
}

// "Usa um alvo deprecado": linha de uso do consumidor, dentro da janela, num alvo com deprecação que não foi cancelada.
const USING = `EXISTS (SELECT 1 FROM governance.api_consumer_usage u JOIN governance.api_deprecations d ON d.company_id = u.company_id AND d.target = u.target_key AND d.status <> 'CANCELLED'
  WHERE u.consumer_id = c.id AND u.last_seen_at >= now() - make_interval(days => :activeDays))`;

function whereOf(filters) {
  const parts = ['c.company_id = :companyId'];
  if (filters.kind) parts.push('c.kind = :kind');
  if (filters.status) parts.push('c.status = :status');
  if (filters.apiVersion) parts.push("(c.api_version_used = :apiVersion OR EXISTS (SELECT 1 FROM governance.api_consumer_usage v WHERE v.consumer_id = c.id AND v.target_key = 'MAJOR:' || :apiVersion))");
  if (filters.usingDeprecated === true) parts.push(USING);
  if (filters.usingDeprecated === false) parts.push(`NOT ${USING}`);
  return parts.join(' AND ');
}

async function pageOfConsumers({ companyId, filters, activeDays, limit, offset }, transaction) {
  const replacements = { companyId, activeDays, limit, offset, kind: null, status: null, apiVersion: null, ...filters };
  const where = whereOf(filters);
  const total = (await select(`SELECT count(*)::int AS n FROM governance.api_consumers c WHERE ${where}`, replacements, transaction))[0].n;
  const items = await select(`SELECT ${COLUMNS} FROM governance.api_consumers c WHERE ${where} ORDER BY c.name, c.id LIMIT :limit OFFSET :offset`, replacements, transaction);
  return { items, total };
}

/** Uso por alvo dos consumidores da página (todas as linhas, para as versões; a janela é aplicada ao cruzar com as deprecações). */
const usageOf = (companyId, ids, transaction) => (ids.length ? select(
  'SELECT consumer_id AS "consumerId", target_key AS "targetKey", last_seen_at AS "lastSeenAt" FROM governance.api_consumer_usage WHERE company_id = :companyId AND consumer_id IN (:ids)', { companyId, ids }, transaction
) : []);

module.exports = { KINDS, STATUSES, readFilters, pageOfConsumers, usageOf };
