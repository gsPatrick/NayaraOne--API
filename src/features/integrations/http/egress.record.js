'use strict';

const { recordError } = require('../errors');

/**
 * Repórter de saída bloqueada (M9-D244 3.2): grava um erro de integração (origem CONTRACT, classe SECURITY, gravidade HIGH)
 * por esquema inseguro ou host fora da lista, na transação de quem montou o cliente e em savepoint, para que a falha de
 * gravação nunca esconda a recusa original. O modo `log` só registra no log da aplicação e não grava erro.
 * Guarda só o host e o motivo: nunca a URL com query.
 */
function makeEgressRecorder(tenant, connection, transaction) {
  return async function registrar(evento) {
    if (evento.decision === 'LOGGED' || !transaction) return;
    await transaction.sequelize.query('SAVEPOINT erro_egress', { transaction });
    try {
      await recordError({ groupId: tenant.groupId, companyId: tenant.companyId }, {
        connectionId: connection.id, providerCode: connection.providerCode, source: 'CONTRACT', errorClass: 'SECURITY',
        errorCode: evento.code, operation: 'egress', httpStatus: 502,
        message: evento.code === 'INTEGRATION_TLS_REQUIRED' ? 'A integração tentou uma conexão sem HTTPS.' : 'A integração tentou chamar um destino fora da lista permitida.',
        payload: { host: evento.host, method: evento.method || null, mode: evento.mode },
      }, transaction);
      await transaction.sequelize.query('RELEASE SAVEPOINT erro_egress', { transaction });
    } catch (err) {
      await transaction.sequelize.query('ROLLBACK TO SAVEPOINT erro_egress', { transaction });
      throw err;
    }
  };
}

module.exports = { makeEgressRecorder };
