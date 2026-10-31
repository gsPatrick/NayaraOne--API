'use strict';

const { sequelize } = require('../../../models');
const errors = require('./dry.errors');

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * O ensaio só roda em banco descartável (M9-D908 §6): o ambiente criado por `scripts/withDisposableDb.js` marca `DISPOSABLE_DB=1` e o endereço do banco é local. Sem a marca, ou com
 * o banco fora desta máquina (como a homologação compartilhada), o ensaio é recusado antes de ler ou gravar qualquer coisa.
 */
function assertDisposableDatabase() {
  const host = String((sequelize.config && sequelize.config.host) || '').toLowerCase();
  if (process.env.DISPOSABLE_DB !== '1' || (host && !LOCAL_HOSTS.includes(host))) throw errors.sharedDatabase();
}

module.exports = { assertDisposableDatabase };
