'use strict';

const logger = require('../../../../utils/logger');
const { recordError } = require('../../errors');

/**
 * Auditoria dos bloqueios (M9-D245 6): host e motivo, nunca a URL completa nem a query. Sempre vai ao log; com `tenant` e
 * `transaction` (e a conexão, quando há) grava também um erro de integração HIGH (origem CONTRACT, classe SECURITY), em savepoint.
 */
async function auditBlock(err, { flow, tenant, transaction, connection }) {
  logger.warn({ flow, host: err.host, reason: err.reason }, 'Busca de URL de terceiro bloqueada.');
  if (!tenant?.companyId || !tenant?.groupId || !transaction) return;
  await transaction.sequelize.query('SAVEPOINT erro_ssrf', { transaction });
  try {
    await recordError({ groupId: tenant.groupId, companyId: tenant.companyId }, {
      connectionId: connection?.id || null, providerCode: connection?.providerCode || `fluxo:${flow}`.slice(0, 48), source: 'CONTRACT', errorClass: 'SECURITY',
      errorCode: err.code, operation: 'ssrf_fetch', httpStatus: err.statusCode, message: 'Uma busca de URL externa foi bloqueada.',
      payload: { flow, host: err.host, reason: err.reason },
    }, transaction);
    await transaction.sequelize.query('RELEASE SAVEPOINT erro_ssrf', { transaction });
  } catch (e) {
    await transaction.sequelize.query('ROLLBACK TO SAVEPOINT erro_ssrf', { transaction });
    logger.warn({ flow, err: e.message }, 'Falha ao gravar o bloqueio de URL externa.');
  }
}

module.exports = { auditBlock };
