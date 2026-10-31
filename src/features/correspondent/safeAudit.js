'use strict';

const { sequelize } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * safeAudit — auditoria "best effort": roda num savepoint, então uma falha dela NÃO deixa a transação do
 * Postgres abortada (um erro engolido sem savepoint faz toda a query seguinte falhar sem causa visível).
 */
async function safeAudit(entry, transaction) {
  try {
    await sequelize.transaction({ transaction }, (savepoint) => registrarAuditoria(entry, savepoint));
  } catch (err) {
    // a auditoria extra nunca derruba a operação principal
  }
}

module.exports = { safeAudit };
