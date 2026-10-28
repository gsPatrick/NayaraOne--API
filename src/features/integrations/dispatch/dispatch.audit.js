'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { AUDIT_ACTION, ENTITY_TYPE } = require('./dispatch.constants');

/** Visão do envio para a auditoria: estado, contadores e chave; nunca o conteúdo. */
const visao = (d) => ({
  status: d.status, attempts: d.attempts, maxAttempts: d.maxAttempts, operation: d.operation, idempotencyKey: d.idempotencyKey,
  payloadHash: d.payloadHash, externalResourceId: d.externalResourceId || null, lastErrorCode: d.lastErrorCode || null,
});

async function auditarMudanca(ctx, antes, depois, motivo, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null,
    action: AUDIT_ACTION, entityType: ENTITY_TYPE, entityId: depois.id,
    beforeJson: antes ? visao(antes) : { registro: 'Não existia (envio criado)' }, afterJson: visao(depois), reason: motivo,
  }, transaction);
}

module.exports = { auditarMudanca, visao };
