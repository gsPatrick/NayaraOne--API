'use strict';

/**
 * M9-D601 — armazenamento dos pedidos de exportação (analytics.export_jobs).
 *
 * O pedido nasce na transação da requisição do usuário (sem a GUC do worker): só em nome de quem pede
 * (requested_by = usuário do contexto), QUEUED, com escopo e filtros CONGELADOS (gatilho ANA07). O
 * andamento (RUNNING, READY, FAILED, EXPIRED, contagem de downloads) é do worker, com a GUC de escrita.
 * O fluxo completo (risco, MFA, permissão, arquivo, download) é da M9-D701; aqui ficam as regras de
 * integridade que valem para qualquer chamador.
 */

const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { run, invalid, requireOneOf, isPlainObject, assertWriter, MSG } = require('./analyticsStoreSupport');
const { assertExportTransition } = require('./exportTransitions');

const CODE = 'ANALYTICS_EXPORT_INVALID';
const RISK_LEVELS = ['LOW', 'HIGH'];
const STATUSES = ['QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED'];
const HASH_RE = /^[0-9a-f]{64}$/;
const FROZEN_KEYS = ['scope', 'filters', 'requestedBy', 'riskLevel', 'dashboardCode', 'metricCode', 'companyId', 'groupId', 'mfaStepUpId'];
const STATE_COLUMNS = {
  status: 'status', rowCount: 'row_count', fileId: 'file_id', fileSha256: 'file_sha256', expiresAt: 'expires_at',
  downloadCount: 'download_count', maskedFields: 'masked_fields', errorCode: 'error_code',
};

function validateRequest(input, ctx) {
  if (!input.groupId) throw invalid(CODE, 'Informe o grupo.');
  if (!input.requestedBy) throw invalid(CODE, 'Informe quem pediu a exportação.');
  if (ctx?.actorUserId && input.requestedBy !== ctx.actorUserId) {
    throw AppError.forbidden('A exportação só pode ser pedida em nome de quem está logado.', 'ANALYTICS_EXPORT_REQUESTER_MISMATCH');
  }
  if (!input.dashboardCode && !input.metricCode) throw invalid(CODE, 'Informe o painel ou o indicador a exportar.');
  requireOneOf(input.riskLevel, RISK_LEVELS, 'Nível de risco', CODE);
  if (input.riskLevel === 'HIGH' && !input.mfaStepUpId) throw invalid(CODE, 'Exportação de risco alto exige a confirmação por MFA (mfaStepUpId).');
  if (!isPlainObject(input.scope)) throw invalid(CODE, 'O escopo da exportação deve ser um objeto.');
  if (input.filters !== undefined && !isPlainObject(input.filters)) throw invalid(CODE, 'Os filtros da exportação devem ser um objeto.');
}

/** Enfileira o pedido (QUEUED) com escopo e filtros congelados. Roda na transação da requisição do usuário. */
async function createExportJob(input, ctx, transaction) {
  validateRequest(input, ctx);
  return run(async () => {
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.export_jobs
         (company_id, group_id, requested_by, dashboard_code, metric_code, scope, filters, risk_level, mfa_step_up_id, status, expires_at)
       VALUES (:companyId, :groupId, :requestedBy, :dashboardCode, :metricCode, CAST(:scope AS jsonb), CAST(:filters AS jsonb), :riskLevel,
          :mfaStepUpId, 'QUEUED', :expiresAt)
       RETURNING *`,
      {
        replacements: {
          companyId: input.companyId || null, groupId: input.groupId, requestedBy: input.requestedBy,
          dashboardCode: input.dashboardCode || null, metricCode: input.metricCode || null, scope: JSON.stringify(input.scope),
          filters: JSON.stringify(input.filters || {}), riskLevel: input.riskLevel, mfaStepUpId: input.mfaStepUpId || null,
          expiresAt: input.expiresAt || null,
        },
        transaction,
      }
    );
    await registrarAuditoria(
      {
        groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action: 'analytics.export.request',
        entityType: 'analytics.export_job', entityId: row.id, beforeJson: null,
        afterJson: { dashboardCode: row.dashboard_code, metricCode: row.metric_code, riskLevel: row.risk_level, scope: row.scope, filters: row.filters },
        reason: `Pedido de exportação (${row.dashboard_code || row.metric_code}), risco ${row.risk_level}`,
      },
      transaction
    );
    return row;
  });
}

function validatePatch(patch, current) {
  const next = { ...current, ...patch };
  if (patch.status !== undefined) requireOneOf(patch.status, STATUSES, 'Status', CODE);
  if (patch.fileSha256 != null && !HASH_RE.test(patch.fileSha256)) throw invalid(CODE, 'O hash do arquivo deve ser SHA-256 em hexadecimal.');
  for (const key of ['rowCount', 'downloadCount']) {
    if (patch[key] != null && (!Number.isInteger(patch[key]) || patch[key] < 0)) throw invalid(CODE, 'Contagens devem ser inteiros a partir de 0.');
  }
  if (next.status === 'READY' && (next.fileSha256 == null || next.expiresAt == null || next.rowCount == null)) {
    throw invalid(CODE, 'Exportação pronta exige hash do arquivo, número de linhas e expiração.');
  }
  if (next.status === 'FAILED' && !next.errorCode) throw invalid(CODE, 'Exportação com falha exige o código do erro.');
}

/** Andamento do job (worker). Escopo, filtros e demais campos do pedido são imutáveis: 409 ANALYTICS_EXPORT_SCOPE_FROZEN. */
async function updateExportJobState(jobId, patch, transaction) {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) throw invalid(CODE, 'Informe o que mudar no andamento.');
  if (Object.keys(patch).some((k) => FROZEN_KEYS.includes(k))) throw AppError.conflict(MSG.EXPORT_FROZEN, 'ANALYTICS_EXPORT_SCOPE_FROZEN');
  const unknown = Object.keys(patch).filter((k) => !STATE_COLUMNS[k]);
  if (unknown.length) throw invalid(CODE, `Campos não permitidos: ${unknown.join(', ')}.`);
  await assertWriter(transaction);
  return run(async () => {
    const [rows] = await sequelize.query('SELECT * FROM analytics.export_jobs WHERE id = :id FOR UPDATE', { replacements: { id: jobId }, transaction });
    if (!rows[0]) throw AppError.notFound('Exportação não encontrada.', 'ANALYTICS_EXPORT_NOT_FOUND');
    const cur = rows[0];
    validatePatch(patch, {
      status: cur.status, fileSha256: cur.file_sha256, expiresAt: cur.expires_at, rowCount: cur.row_count, errorCode: cur.error_code,
    });
    if (patch.status !== undefined) assertExportTransition(cur.status, patch.status); // M9-D701 3.7
    const keys = Object.keys(patch);
    const sets = keys.map((k) => (k === 'maskedFields' ? `${STATE_COLUMNS[k]} = CAST(:${k} AS jsonb)` : `${STATE_COLUMNS[k]} = :${k}`));
    const replacements = { id: jobId, ...patch };
    if (patch.maskedFields !== undefined) replacements.maskedFields = JSON.stringify(patch.maskedFields);
    const [[row]] = await sequelize.query(`UPDATE analytics.export_jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = :id RETURNING *`, { replacements, transaction });
    return row;
  });
}

module.exports = { createExportJob, updateExportJobState };
