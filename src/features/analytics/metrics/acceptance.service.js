'use strict';

/**
 * M9-D708 (3.4) — o aceite do owner. `decide(metricCode, version, userId, decision, evidenceFileId, { ctx, transaction, comment })` registra ACEITAR (ACCEPTED) ou
 * REJEITAR (REJECTED) sobre a linha PENDING gravada por reconcile. Sem rota nem tela (o livro não pede): o comando é scripts/analytics/acceptMetric.js.
 * Ordem das conferências: decisão válida (400) -> permissão analytics:accept (403) -> métrica existente (404) -> é o owner (403 ANALYTICS_ACCEPT_NOT_OWNER) ->
 * versão é a vigente (409) -> evidência é arquivo da empresa (400) -> linha reconciliada e travada FOR UPDATE, ainda PENDING (409) -> aceitar com diferença acima da
 * tolerância gravada na reconciliação (409 ANALYTICS_ACCEPT_DIFFERENCE). Auditoria com antes e depois e a evidência.
 */
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const money = require('./formulas/money');
const { findDefinition } = require('./registry.read');
const { assertPermission, P } = require('../security');
const store = require('./acceptance.store');
const { isOwner } = require('./acceptance.owner');
const { readAmbiente, readTolerance } = require('./acceptance.settings');

const DECISIONS = Object.freeze({ ACEITAR: 'ACCEPTED', ACCEPT: 'ACCEPTED', ACCEPTED: 'ACCEPTED', REJEITAR: 'REJECTED', REJECT: 'REJECTED', REJECTED: 'REJECTED' });
const bad = (message, code, details) => AppError.badRequest(message, code, details);
const absolute = (v) => (String(v).startsWith('-') ? String(v).slice(1) : String(v));

async function assertEvidence(ctx, evidenceFileId, transaction) {
  if (typeof evidenceFileId !== 'string' || !evidenceFileId.trim()) {
    throw bad('Anexe a evidência (print ou planilha da conferência).', 'ANALYTICS_ACCEPT_EVIDENCE_REQUIRED');
  }
  const rows = await sequelize.query('SELECT 1 FROM people.files WHERE id::text = :id AND company_id = :companyId AND deleted_at IS NULL LIMIT 1',
    { type: QueryTypes.SELECT, replacements: { id: evidenceFileId, companyId: ctx.companyId }, transaction });
  if (!rows.length) throw bad('O arquivo de evidência não existe ou não pertence a esta empresa.', 'ANALYTICS_ACCEPT_EVIDENCE_NOT_FOUND');
}

async function currentVersionNumber(definition, transaction) {
  const rows = await sequelize.query('SELECT version FROM analytics.metric_versions WHERE id = :id', { type: QueryTypes.SELECT, replacements: { id: definition.current_version_id }, transaction });
  return rows[0] ? rows[0].version : null;
}

function assertDecidable(row, status) {
  if (!row) throw AppError.conflict('Rode a reconciliação deste indicador antes de pedir o aceite.', 'ANALYTICS_ACCEPT_NOT_RECONCILED');
  if (row.status !== 'PENDING') {
    throw AppError.conflict('Este indicador já foi decidido; reconcilie de novo para abrir outra decisão.', 'ANALYTICS_ACCEPT_ALREADY_DECIDED', { status: row.status });
  }
  if (status !== 'ACCEPTED') return;
  if (row.difference === null || row.difference === undefined) {
    throw AppError.conflict('Não há diferença calculada para este indicador (falta o valor do BI ou do relatório); não é possível aceitar.', 'ANALYTICS_ACCEPT_NOT_RECONCILED');
  }
  const tolerance = row.tolerance === null || row.tolerance === undefined ? '0' : String(row.tolerance);
  if (money.cmp(absolute(row.difference), tolerance) > 0) {
    throw AppError.conflict('A diferença está acima da tolerância; o aceite não é permitido.', 'ANALYTICS_ACCEPT_DIFFERENCE', { diferenca: String(row.difference), tolerancia: tolerance });
  }
}

async function decide(metricCode, version, userId, decision, evidenceFileId, { ctx, transaction, comment } = {}) {
  const status = DECISIONS[String(decision || '').toUpperCase()];
  if (!status) throw bad('A decisão deve ser ACEITAR ou REJEITAR.', 'ANALYTICS_ACCEPT_INVALID', { decisao: decision });
  if (!ctx || !transaction) throw new Error('decide exige ctx e transaction.');
  assertPermission(ctx, P.ACCEPT);
  const definition = await findDefinition(String(metricCode), transaction);
  if (!(await isOwner(definition, userId, ctx.companyId, transaction))) {
    throw AppError.forbidden('Somente o responsável pelo indicador pode aceitá-lo.', 'ANALYTICS_ACCEPT_NOT_OWNER');
  }
  const current = await currentVersionNumber(definition, transaction);
  if (!Number.isInteger(version) || version !== current) {
    throw AppError.conflict('A versão informada não é a vigente do indicador; o aceite vale só para a versão atual.', 'ANALYTICS_ACCEPT_VERSION_STALE', { versaoVigente: current });
  }
  await assertEvidence(ctx, evidenceFileId, transaction);
  const row = await store.find(ctx.companyId, metricCode, version, transaction, { lock: true });
  assertDecidable(row, status);
  const closed = await store.close(ctx, { id: row.id, status, userId, evidenceFileId, comment }, transaction);
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: userId, action: 'analytics.metric.acceptance_decided', entityType: 'analytics.metric_acceptance', entityId: row.id,
    beforeJson: { status: row.status, difference: row.difference, tolerance: row.tolerance },
    afterJson: { metricCode, version, status, difference: row.difference, tolerance: row.tolerance, evidenceFileId, comment: comment || null },
    reason: `${status === 'ACCEPTED' ? 'Aceite' : 'Rejeição'} do indicador ${metricCode} (versão ${version}) pelo responsável.`,
  }, transaction);
  return { metricCode, version, status: closed.status, difference: closed.difference, evidenceFileId, acceptedBy: userId, ambiente: await readAmbiente(ctx, transaction) };
}

module.exports = { decide, readAmbiente, readTolerance, DECISIONS };
