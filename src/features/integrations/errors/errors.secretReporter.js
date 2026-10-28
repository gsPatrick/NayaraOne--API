'use strict';

const logger = require('../../../utils/logger');
const { recordError } = require('./errors.record');

/**
 * Repórter de incidente de credencial (M9-D202 regra 4, DI-D202-7): quando o cofre leva uma connection a AUTH_FAILED por
 * vencimento, abre um erro de integração (origem SECRET, classe AUTH, severidade HIGH). Roda na transação de quem
 * detectou (`contexto.transaction`), em savepoint, para que uma falha aqui nunca derrube a operação principal.
 */
async function reportarIncidenteDeCredencial(incidente, { transaction } = {}) {
  if (!transaction) {
    logger.warn({ code: incidente.code, connectionId: incidente.connectionId }, 'Incidente de credencial sem transação: erro de integração não aberto.');
    return;
  }
  await transaction.sequelize.query('SAVEPOINT erro_incidente_credencial', { transaction });
  try {
    await recordError(
      { groupId: incidente.groupId, companyId: incidente.companyId },
      {
        connectionId: incidente.connectionId,
        providerCode: incidente.providerCode,
        source: 'SECRET',
        sourceRefId: incidente.connectionId,
        errorClass: 'AUTH',
        errorCode: incidente.code,
        message: 'A credencial desta integração venceu. A conexão foi colocada em falha de autenticação até a rotação.',
        operation: 'secret_expiry',
        payload: { environment: incidente.environment, deadline: incidente.deadline ? new Date(incidente.deadline).toISOString() : null },
      },
      transaction
    );
    await transaction.sequelize.query('RELEASE SAVEPOINT erro_incidente_credencial', { transaction });
  } catch (err) {
    await transaction.sequelize.query('ROLLBACK TO SAVEPOINT erro_incidente_credencial', { transaction });
    throw err;
  }
}

module.exports = { reportarIncidenteDeCredencial };
