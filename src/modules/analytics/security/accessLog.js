'use strict';

/**
 * M9-D700 (3.5) — log de acesso do BI (analytics.access_log), imutável (sem UPDATE/DELETE para o runtime; gatilho do banco).
 * Grava: usuário, empresa, rota, métrica/painel, filtro, linhas devolvidas, se houve mascaramento, IP hasheado, correlation_id
 * e instante. Cobre abertura de painel, métrica, drill-down, exportação (pedido, geração, download), brief e consulta da NAY.
 *
 * A gravação roda em transação PRÓPRIA (com o contexto de tenant) quando o chamador não passa uma gravável: os GET de /analytics
 * correm em transação READ ONLY (M9-D612) e não podem gravar. Falha ao gravar o log de um acesso sensível derruba o acesso.
 */
const crypto = require('crypto');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { getCurrentCorrelationId } = require('../../../middlewares/correlationId.middleware');
const { assertPermission } = require('./permissionGuard');
const { P } = require('./permissionCatalog');
const { readParam, KEYS } = require('./securityParams');
const { maskRestricted } = require('./masking');

const ACTIONS = Object.freeze([
  'DASHBOARD_OPEN', 'METRIC_READ', 'DRILLDOWN', 'EXPORT_REQUEST', 'EXPORT_GENERATE', 'EXPORT_DOWNLOAD', 'BRIEF_GENERATE', 'BRIEF_READ', 'NAY_QUERY',
]);
const MAX_FILTER_BYTES = 4000;
let fallbackKey = null;

/** HMAC do IP com chave derivada do segredo de acesso (sem variável nova); sem segredo, chave aleatória do processo. */
function ipKey() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (secret) return crypto.createHmac('sha256', secret).update('analytics.access_log.ip').digest();
  fallbackKey = fallbackKey || crypto.randomBytes(32);
  return fallbackKey;
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHmac('sha256', ipKey()).update(String(ip)).digest('hex');
}

function safeFilters(filters) {
  const { data } = maskRestricted(filters && typeof filters === 'object' ? filters : {});
  const text = JSON.stringify(data);
  return text.length > MAX_FILTER_BYTES ? JSON.stringify({ truncated: true }) : text;
}

async function insertRow(ctx, entry, transaction) {
  const [[row]] = await sequelize.query(
    `INSERT INTO analytics.access_log
       (company_id, group_id, user_id, action, route, resource_type, resource_code, filters, rows_returned, masking_applied, ip_hash, correlation_id)
     VALUES (:companyId, :groupId, :userId, :action, :route, :resourceType, :resourceCode, CAST(:filters AS jsonb), :rows, :masked, :ipHash, :correlationId)
     RETURNING id, occurred_at AS "occurredAt"`,
    {
      replacements: {
        companyId: ctx.companyId, groupId: ctx.groupId, userId: ctx.actorUserId || null, action: entry.action, route: entry.route || null,
        resourceType: entry.resourceType, resourceCode: entry.resourceCode || null, filters: safeFilters(entry.filters),
        rows: Number.isInteger(entry.rowsReturned) ? entry.rowsReturned : 0, masked: entry.maskingApplied === true,
        ipHash: hashIp(entry.ip), correlationId: entry.correlationId || getCurrentCorrelationId() || null,
      },
      transaction,
    }
  );
  return row;
}

async function recordAccess(ctx, entry, transaction = null) {
  if (!ACTIONS.includes(entry.action)) throw AppError.internal('Ação de log de acesso desconhecida.', 'ANALYTICS_ACCESS_LOG_ACTION');
  if (!entry.resourceType) throw AppError.internal('O log de acesso exige o tipo do recurso.', 'ANALYTICS_ACCESS_LOG_RESOURCE');
  if (transaction) return insertRow(ctx, entry, transaction);
  return sequelize.transaction(async (tx) => {
    await sequelize.query(
      "SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
      { replacements: { g: ctx.groupId, c: ctx.companyId, u: ctx.actorUserId || '' }, transaction: tx }
    );
    return insertRow(ctx, entry, tx);
  });
}

/** Consulta do log (só com analytics:audit:read), mais recente primeiro; `limit` respeita o teto do parâmetro. */
async function listAccessLog(ctx, { action = null, userId = null, from = null, to = null, limit = null } = {}, transaction) {
  assertPermission(ctx, P.AUDIT_READ);
  const max = Number(await readParam(KEYS.LOG_MAX_ROWS, ctx, transaction));
  const size = Math.min(Number.isInteger(limit) && limit > 0 ? limit : max, max);
  if (action && !ACTIONS.includes(action)) throw AppError.badRequest('Ação de log inválida.', 'ANALYTICS_ACCESS_LOG_ACTION');
  const [rows] = await sequelize.query(
    `SELECT id, user_id AS "userId", action, route, resource_type AS "resourceType", resource_code AS "resourceCode", filters,
            rows_returned AS "rowsReturned", masking_applied AS "maskingApplied", ip_hash AS "ipHash", correlation_id AS "correlationId",
            occurred_at AS "occurredAt"
       FROM analytics.access_log
      WHERE (CAST(:action AS text) IS NULL OR action = CAST(:action AS text))
        AND (CAST(:userId AS uuid) IS NULL OR user_id = CAST(:userId AS uuid))
        AND (CAST(:from AS timestamptz) IS NULL OR occurred_at >= CAST(:from AS timestamptz))
        AND (CAST(:to AS timestamptz) IS NULL OR occurred_at < CAST(:to AS timestamptz))
      ORDER BY occurred_at DESC, id LIMIT :size`,
    { replacements: { action, userId, from, to, size }, transaction }
  );
  return rows;
}

module.exports = { ACTIONS, hashIp, recordAccess, listAccessLog };
