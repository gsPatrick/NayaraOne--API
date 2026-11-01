'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

const CLEAR_READ_ACTION = 'governance.field_access.clear_read';
const FAIL_CLOSED_ACTION = 'governance.field_access.fail_closed';

/** Leitura em claro de campo HIGH ou RESTRICTED (M9-D915 §3.2): grava as referências e o contexto, nunca o valor. Uma linha por chamada. */
async function recordClearRead(tenant, refs, context, transaction, rowCount = null) {
  if (!refs.length) return;
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId || null, action: CLEAR_READ_ACTION, entityType: 'DataClassification', entityId: null,
    beforeJson: null, afterJson: { context, fields: refs, ...(rowCount === null ? {} : { rowCount }) },
    reason: `Leitura em claro de ${refs.length} campo(s) HIGH ou RESTRICTED (${context}${rowCount === null ? '' : `, ${rowCount} linha(s)`}).`,
  }, transaction);
}

/** Falha ao consultar o registro (fail closed): o campo saiu mascarado ou omitido; a auditoria guarda só a referência e o código da falha. */
async function recordFailClosed(tenant, ref, context, code, transaction) {
  try {
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId || null, action: FAIL_CLOSED_ACTION, entityType: 'DataClassification', entityId: null,
      beforeJson: null, afterJson: { context, field: ref, code }, reason: 'Registro de classificação indisponível: o campo saiu protegido (fail closed).',
    }, transaction);
  } catch (error) { /* a própria auditoria pode ser o que falhou; o campo já saiu protegido */ }
}

module.exports = { recordClearRead, recordFailClosed, CLEAR_READ_ACTION, FAIL_CLOSED_ACTION };
