'use strict';

const AppError = require('../../../../utils/AppError');
const { q, SELECT } = require('../healthStore');
const { ALERT_TYPES } = require('./alerts.constants');

const LIMIT_MAX = 200;
const LIMIT_PADRAO = 50;

const serialize = (a) => ({
  id: a.id, connectionId: a.connection_id, provider: a.provider_code, type: a.alert_type, severity: a.severity, status: a.status, details: a.details,
  runbookPath: a.runbook_path, openedAt: a.opened_at, lastNotifiedAt: a.last_notified_at, notifyCount: a.notify_count, resolvedAt: a.resolved_at, resolution: a.resolution,
});

/** Alertas abertos da empresa agrupados por connection, para o painel: [{ id, type, severity, openedAt }]. */
async function listOpenAlertsByConnection(ctx, transaction) {
  const rows = await q(
    `SELECT id, connection_id, alert_type, severity, opened_at FROM "integration"."alerts" WHERE company_id = :c AND status = 'OPEN' ORDER BY opened_at DESC, id`, { c: ctx.companyId }, transaction, SELECT,
  );
  const mapa = new Map();
  rows.forEach((r) => mapa.set(r.connection_id, [...(mapa.get(r.connection_id) || []), { id: r.id, type: r.alert_type, severity: r.severity, openedAt: r.opened_at }]));
  return mapa;
}

/** GET /admin/integrations/alerts: alertas da empresa, filtro por estado, tipo e connection, mais recentes primeiro. */
async function listAlerts(ctx, query = {}, transaction) {
  const invalido = (campo) => AppError.unprocessable('Parâmetro de consulta inválido.', 'VALIDATION_ERROR', { campo });
  const status = query.status === undefined || query.status === '' ? null : query.status;
  if (status !== null && !['OPEN', 'RESOLVED'].includes(status)) throw invalido('status');
  const type = query.type === undefined || query.type === '' ? null : query.type;
  if (type !== null && !ALERT_TYPES.includes(type)) throw invalido('type');
  const limit = query.limit === undefined || query.limit === '' ? LIMIT_PADRAO : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw invalido('limit');
  const rows = await q(
    `SELECT * FROM "integration"."alerts" WHERE company_id = :c AND (CAST(:s AS text) IS NULL OR status = :s) AND (CAST(:t AS text) IS NULL OR alert_type = :t)
      ORDER BY opened_at DESC, id LIMIT :l`,
    { c: ctx.companyId, s: status, t: type, l: limit }, transaction, SELECT,
  );
  return { items: rows.map(serialize) };
}

module.exports = { listOpenAlertsByConnection, listAlerts, serialize };
