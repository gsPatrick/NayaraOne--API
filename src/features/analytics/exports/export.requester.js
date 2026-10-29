'use strict';

/**
 * M9-D701 (3.3) — o contexto do solicitante no momento da execução: as permissões de AGORA (papéis ativos na empresa), não as do pedido. Se uma permissão
 * exigida foi removida entre o pedido e a geração, a verificação do acesso falha e o job vira FAILED com ANALYTICS_EXPORT_PERMISSION_REVOKED.
 */
const { getEffectiveAccess } = require('../../../engines/biExport/exportRequesterAccess');
const { REVOKED_CODE } = require('./export.errors');

const REVOKED_STATUS_CODES = new Set(['PERMISSION_DENIED', 'ANALYTICS_DRILLDOWN_FORBIDDEN', 'ANALYTICS_GROUP_SCOPE_FORBIDDEN']);

async function loadRequesterContext(job, transaction) {
  const access = await getEffectiveAccess(job.requestedBy, job.companyId, transaction);
  return { groupId: job.groupId, companyId: job.companyId, actorUserId: job.requestedBy, permissions: access.permissions };
}

/** Código gravado em `error_code` para o erro que derrubou a geração. */
function failureCodeOf(err) {
  if (err && REVOKED_STATUS_CODES.has(err.code)) return REVOKED_CODE;
  if (err && typeof err.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) && err.isOperational) return err.code;
  return 'ANALYTICS_EXPORT_FAILED';
}

module.exports = { loadRequesterContext, failureCodeOf };
