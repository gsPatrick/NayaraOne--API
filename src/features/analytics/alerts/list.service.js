'use strict';

/**
 * M9-D703 (3.1) — GET /analytics/alerts. Lê analytics.alert_instances da empresa da sessão (RLS), ordena por gravidade (CRITICAL primeiro) e, no empate, por
 * abertura decrescente, filtra por estado/gravidade/métrica e devolve também os totais por gravidade e por estado do conjunto filtrado. Alertas de domínio que
 * o usuário não lê ficam de fora de itens e de totais. Só leitura (roda em transação READ ONLY).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { readAlertParams } = require('./engine.settings');
const { parseAlertQuery, SEVERITIES, STATUSES } = require('./alert.query');
const { readableDomains } = require('./alert.access');
const { formatValue, normalizeDecimal } = require('./list.format');
const { linkOf } = require('./open.effects');

const COLUMNS = `i.id, d.alert_code, COALESCE(i.metric_code, d.metric_code) AS metric_code, i.severity, i.status, i.opened_at, i.occurrence_count, i.last_value::text AS last_value,
         d.owner_user_id, d.owner_role, i.acknowledged_by, i.acknowledged_at, i.task_id, i.company_id, i.group_id, u.unit`;
const FROM_SQL = `
    FROM analytics.alert_instances i
    JOIN analytics.alert_definitions d ON d.id = i.alert_definition_id
    LEFT JOIN LATERAL (SELECT m.domain FROM analytics.metric_definitions m WHERE m.metric_code = COALESCE(i.metric_code, d.metric_code) AND m.status <> 'RETIRED'
                        ORDER BY (m.company_id IS NULL), (m.group_id IS NULL) LIMIT 1) md ON true
    LEFT JOIN LATERAL (SELECT v.unit FROM analytics.metric_snapshots s JOIN analytics.metric_versions v ON v.id = s.metric_version_id
                        WHERE s.id = COALESCE(i.last_snapshot_id, i.metric_snapshot_id)) u ON true`;
const SELECT = `SELECT ${COLUMNS}${FROM_SQL}`;

function whereOf(f) {
  const parts = ['i.company_id = :companyId', 'i.status IN (:statuses)', "COALESCE(md.domain, 'GENERAL') IN (:domains)"];
  if (f.severity) parts.push('i.severity = :severity');
  if (f.metricCode) parts.push('COALESCE(i.metric_code, d.metric_code) = :metricCode');
  if (f.id) parts.push('i.id = :id');
  return ` WHERE ${parts.join(' AND ')}`;
}

const replacementsOf = (f) => ({ companyId: f.companyId, statuses: f.statuses, domains: f.domains, severity: f.severity || null, metricCode: f.metricCode || null, id: f.id || null });

function toItem(row, params) {
  return {
    id: row.id,
    alertCode: row.alert_code,
    metricCode: row.metric_code,
    severity: row.severity,
    status: row.status,
    openedAt: row.opened_at,
    occurrenceCount: row.occurrence_count,
    lastValue: normalizeDecimal(row.last_value),
    formattedLastValue: formatValue(row.last_value, row.unit),
    owner: { userId: row.owner_user_id || null, role: row.owner_role || null },
    acknowledgedBy: row.acknowledged_by || null,
    acknowledgedAt: row.acknowledged_at || null,
    taskId: row.task_id || null,
    link: linkOf(params, row.id),
  };
}

async function totalsOf(f, transaction) {
  const [rows] = await sequelize.query(
    `SELECT s.severity, s.status, count(*)::int AS n FROM (SELECT i.severity, i.status${FROM_SQL}${whereOf(f)}) s GROUP BY s.severity, s.status`,
    { replacements: replacementsOf(f), transaction }
  );
  const totals = { total: 0, bySeverity: Object.fromEntries(SEVERITIES.slice().reverse().map((s) => [s, 0])), byStatus: Object.fromEntries(STATUSES.map((s) => [s, 0])) };
  for (const r of rows) {
    totals.total += r.n;
    totals.bySeverity[r.severity] += r.n;
    totals.byStatus[r.status] += r.n;
  }
  return totals;
}

/** ctx = { companyId, groupId, actorUserId, permissions }; query = req.query. */
async function listAlerts(ctx, query, transaction) {
  if (query && query.companyId !== undefined && query.companyId !== ctx.companyId) {
    throw AppError.notFound('Empresa não encontrada ou sem acesso.', 'ANALYTICS_SCOPE_NOT_FOUND');
  }
  const params = await readAlertParams({ companyId: ctx.companyId, groupId: ctx.groupId }, transaction);
  const parsed = parseAlertQuery(query, { defaultPageSize: params.listPageSize, maxPageSize: params.listMaxPageSize });
  const domains = await readableDomains(ctx, transaction);
  const empty = { items: [], page: parsed.page, pageSize: parsed.pageSize, totals: { total: 0, bySeverity: { CRITICAL: 0, WARNING: 0, INFO: 0 }, byStatus: { OPEN: 0, ACKNOWLEDGED: 0, RESOLVED: 0 } } };
  if (!domains.length) return empty;
  const filter = { ...parsed, companyId: ctx.companyId, domains };
  const [rows] = await sequelize.query(
    `${SELECT}${whereOf(filter)}
      ORDER BY CASE i.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, i.opened_at DESC, i.id
      LIMIT :limit OFFSET :offset`,
    { replacements: { ...replacementsOf(filter), limit: parsed.pageSize, offset: (parsed.page - 1) * parsed.pageSize }, transaction }
  );
  return { items: rows.map((r) => toItem(r, params)), page: parsed.page, pageSize: parsed.pageSize, totals: await totalsOf(filter, transaction) };
}

/** Um alerta no formato da lista (sem filtro de estado), ou null se não existe/não é visível. Usado pelo ack. */
async function findAlertItem(ctx, id, transaction) {
  const params = await readAlertParams({ companyId: ctx.companyId, groupId: ctx.groupId }, transaction);
  const domains = await readableDomains(ctx, transaction);
  if (!domains.length) return null;
  const filter = { companyId: ctx.companyId, statuses: STATUSES.slice(), domains, id };
  const [rows] = await sequelize.query(`${SELECT}${whereOf(filter)}`, { replacements: replacementsOf(filter), transaction });
  return rows[0] ? toItem(rows[0], params) : null;
}

module.exports = { listAlerts, findAlertItem, SELECT, whereOf, replacementsOf };
