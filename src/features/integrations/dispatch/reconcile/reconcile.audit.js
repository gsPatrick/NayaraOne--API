'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { ENTITY_TYPE } = require('../dispatch.constants');

const ACTION = 'integration.dispatch.reconciled';

/**
 * Auditoria de cada reconciliação (M9-D215 seção 6): o que a consulta respondeu, estratégia por estratégia, SEM conteúdo do envio e sem
 * segredo (só nomes de estratégia, códigos e o status do fornecedor). Vale também para a consulta inconclusiva, que não muda o estado.
 */
async function auditReconcile(ctx, { dispatchId, before, after, result, trail, source, reason }, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: ACTION, entityType: ENTITY_TYPE, entityId: dispatchId,
    beforeJson: before, afterJson: { ...after, result, source, trail }, reason,
  }, transaction);
}

module.exports = { auditReconcile, ACTION };
