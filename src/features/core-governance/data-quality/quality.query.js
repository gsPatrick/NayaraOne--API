'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const { DOMAIN_BY_ENTITY } = require('./merge.constants');
const { ISSUE_STATUS } = require('./quality.constants');
const settings = require('./quality.settings');
const { parseQuery } = require('./quality.input');
const { listDomains } = require('./stewardship.service');
const { PENDENCY_CODE } = require('./data-quality.constants');

const q = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Resumo da empresa inteira (não depende dos filtros da lista): média geral, média por domínio, issues abertas e domínios sem owner. */
async function buildSummary(tenant, transaction) {
  const base = { companyId: tenant.companyId };
  const [{ avg }] = await q('SELECT round(avg(score), 2) AS avg FROM governance.quality_scores WHERE company_id = :companyId', base, transaction);
  const perEntity = await q('SELECT entity_type, round(avg(score), 2) AS avg FROM governance.quality_scores WHERE company_id = :companyId GROUP BY entity_type', base, transaction);
  const [{ open }] = await q("SELECT count(*)::int AS open FROM governance.quality_issues WHERE company_id = :companyId AND status = 'OPEN'", base, transaction);
  const domains = await listDomains(tenant, transaction);
  const byEntity = Object.fromEntries(perEntity.map((row) => [row.entity_type, Number(row.avg)]));
  return {
    avgScore: avg === null ? null : Number(avg),
    avgScoreByDomain: Object.fromEntries(Object.entries(DOMAIN_BY_ENTITY).map(([entity, domain]) => [domain, byEntity[entity] === undefined ? null : byEntity[entity]])),
    openIssues: open,
    domainsWithoutOwner: domains.filter((domain) => domain.pendencies.some((p) => p.code === PENDENCY_CODE.NO_OWNER)).length,
  };
}

function whereOf(tenant, filters) {
  const replacements = { companyId: tenant.companyId };
  const entity = filters.entityType ? 'AND s.entity_type = :entityType' : '';
  if (filters.entityType) replacements.entityType = filters.entityType;
  const issue = ['i.company_id = s.company_id', 'i.entity_type = s.entity_type', 'i.entity_id = s.entity_id', 'i.status = :status'];
  replacements.status = filters.status || ISSUE_STATUS.OPEN;
  if (filters.severity) { issue.push('i.severity = :severity'); replacements.severity = filters.severity; }
  if (filters.stewardId) { issue.push('i.assigned_steward_id = :stewardId'); replacements.stewardId = filters.stewardId; }
  return { replacements, entity, issueSql: issue.join(' AND ') };
}

async function issuesOf(tenant, items, filters, transaction) {
  if (!items.length) return new Map();
  const { replacements, issueSql } = whereOf(tenant, filters);
  const rows = await q(
    `SELECT i.* FROM governance.quality_issues i JOIN governance.quality_scores s ON s.company_id = i.company_id AND s.entity_type = i.entity_type AND s.entity_id = i.entity_id
      WHERE ${issueSql} AND s.entity_id IN (:ids) ORDER BY i.opened_at, i.rule_code`, { ...replacements, ids: items.map((item) => item.entity_id) }, transaction
  );
  const map = new Map();
  rows.forEach((row) => {
    const list = map.get(`${row.entity_type}:${row.entity_id}`) || [];
    list.push({ id: row.id, ruleCode: row.rule_code, severity: row.severity, status: row.status, openedAt: row.opened_at, resolvedAt: row.resolved_at, assignedStewardId: row.assigned_steward_id });
    map.set(`${row.entity_type}:${row.entity_id}`, list);
  });
  return map;
}

/**
 * GET /data-quality (M9-D806 §3.4): `summary` da empresa e os cadastros avaliados, do pior para o melhor, com as issues que casam com os filtros
 * (padrão: as abertas). Filtro de issue (severity, status, stewardId) mostra só os cadastros que têm uma issue assim. `domain` ou `entityType` limitam a entidade.
 */
async function getDataQuality(tenant, query, transaction) {
  const size = Number(await getSetting(settings.PAGE_SIZE_KEY, tenant, transaction, settings.QUALITY_SETTING_DEFAULTS[settings.PAGE_SIZE_KEY]));
  const filters = parseQuery(query, size);
  const { replacements, entity, issueSql } = whereOf(tenant, filters);
  const exists = filters.issueFiltered ? `AND EXISTS (SELECT 1 FROM governance.quality_issues i WHERE ${issueSql})` : '';
  const base = `FROM governance.quality_scores s WHERE s.company_id = :companyId ${entity} ${exists}`;
  const [{ total }] = await q(`SELECT count(*)::int AS total ${base}`, replacements, transaction);
  const rows = await q(`SELECT s.* ${base} ORDER BY s.score ASC, s.entity_type, s.entity_id LIMIT :limit OFFSET :offset`, { ...replacements, limit: filters.pageSize, offset: (filters.page - 1) * filters.pageSize }, transaction);
  const issues = await issuesOf(tenant, rows, filters, transaction);
  return {
    summary: await buildSummary(tenant, transaction),
    items: rows.map((row) => ({
      entityType: row.entity_type, entityId: row.entity_id, score: Number(row.score), calculatedAt: row.calculated_at, issues: issues.get(`${row.entity_type}:${row.entity_id}`) || [],
    })),
    page: filters.page, pageSize: filters.pageSize, total,
  };
}

module.exports = { getDataQuality };
