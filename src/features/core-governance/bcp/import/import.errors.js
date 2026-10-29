'use strict';

const logger = require('../../../../utils/logger');
const E = require('../bcp.errors');

/** Erro do serviço normal vira recusa do comando (422); erro de governança do próprio BCP segue como está; o resto é falha inesperada registrada. */
function toBcpError(err) {
  if (err && typeof err.code === 'string' && err.code.startsWith('GOV_')) return err;
  if (err && Number(err.statusCode) >= 400 && Number(err.statusCode) < 500) return E.commandRejected(err.message);
  logger.error({ err }, 'Falha inesperada ao importar operação manual do BCP');
  const unexpected = new Error('Falha inesperada ao executar o comando; a operação continua registrada e pode ser importada de novo.');
  unexpected.code = 'INTERNAL_ERROR';
  return unexpected;
}

module.exports = { toBcpError };
