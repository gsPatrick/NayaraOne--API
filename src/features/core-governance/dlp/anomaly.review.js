'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { govNotFound } = require('../governance.errors');
const { requestInvalid, anomalyReasonRequired, anomalyTransition } = require('./dlp.errors');
const { parsePagination, pageResult } = require('../api-governance/standards/pagination.helper');
const settings = require('./anomaly.settings');
const anomalies = require('./anomaly.repository');
const userState = require('./userState.repository');

const DECISIONS = Object.freeze(['CONFIRMED', 'FALSE_POSITIVE']);
/** Transições aceitas (M9-D824 §3.3 item 3): aberta vira uma das duas decisões; confirmada só pode ser revertida para falso positivo. */
const ALLOWED = Object.freeze({ OPEN: ['CONFIRMED', 'FALSE_POSITIVE'], CONFIRMED: ['FALSE_POSITIVE'], FALSE_POSITIVE: [] });

const view = (row) => row;

async function listAnomalies(tenant, query, transaction) {
  const status = query.status ? String(query.status).toUpperCase() : null;
  const kind = query.kind ? String(query.kind).toUpperCase() : null;
  if (status && !['OPEN', 'CONFIRMED', 'FALSE_POSITIVE'].includes(status)) throw requestInvalid('Situação inválida.', { field: 'status' });
  if (kind && !['READ', 'EXPORT'].includes(kind)) throw requestInvalid('Tipo inválido.', { field: 'kind' });
  const paging = await parsePagination(query, tenant, transaction);
  const { rows, total } = await anomalies.list(tenant.companyId, { status, kind, userId: query.userId || null, limit: paging.limit, offset: paging.offset }, transaction);
  return pageResult(rows.map(view), paging, total);
}

/**
 * Revisão humana da anomalia (M9-D824 §3.3 item 3), sempre com motivo e auditada. CONFIRMED prorroga a suspensão para a decisão + `confirmada_horas` (cai sozinha ao
 * vencer); FALSE_POSITIVE tira a contribuição da anomalia e o estado do usuário é recalculado a partir das que continuam abertas ou confirmadas (sem nenhuma, zera os dois flags).
 */
async function reviewAnomaly(tenant, actor, id, body, transaction) {
  const decision = String((body && body.decision) || '').toUpperCase();
  if (!DECISIONS.includes(decision)) throw requestInvalid('Informe a decisão da revisão: CONFIRMED ou FALSE_POSITIVE.', { field: 'decision' });
  const reason = typeof (body && body.reason) === 'string' ? body.reason.trim() : '';
  if (!reason) throw anomalyReasonRequired();
  const before = await anomalies.findById(tenant.companyId, id, transaction, { lock: true });
  if (!before) throw govNotFound('Anomalia não encontrada.');
  if (!ALLOWED[before.status].includes(decision)) throw anomalyTransition(before.status, decision);
  const now = new Date();
  const confirmed = decision === 'CONFIRMED';
  const hours = settings.parseHours(await getSetting(settings.CONFIRMED_HOURS_KEY, tenant, transaction, settings.ANOMALY_SETTING_DEFAULTS[settings.CONFIRMED_HOURS_KEY]), settings.CONFIRMED_HOURS_KEY);
  const after = await anomalies.applyReview(tenant.companyId, id, {
    status: decision, reviewedBy: actor.userId, reviewedAt: now, reason, restrictedUntil: confirmed ? new Date(now.getTime() + hours * 3600 * 1000) : null,
    mfaForcedSince: confirmed ? before.mfaForcedSince : null, mfaForcedUntil: confirmed ? before.mfaForcedUntil : null,
  }, transaction);
  await userState.recompute(tenant, before.userId, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'governance.dlp.anomaly.reviewed', entityType: 'AccessAnomaly', entityId: id,
    beforeJson: { status: before.status, restrictedUntil: before.restrictedUntil }, afterJson: { status: after.status, restrictedUntil: after.restrictedUntil, reason }, reason: `Anomalia de acesso revisada: ${decision}. ${reason}`,
  }, transaction);
  return view(after);
}

module.exports = { listAnomalies, reviewAnomaly };
