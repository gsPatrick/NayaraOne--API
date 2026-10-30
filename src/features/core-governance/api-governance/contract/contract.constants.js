'use strict';

/** Nomes das variáveis de ambiente com as duas conexões que o contract test exige em 127.0.0.1 (enumeração de ambiente, não códigos de erro). */
const DISPOSABLE_ENV_NAMES = ['DATABASE_URL', 'DATABASE_ADMIN_URL'];

module.exports = { DISPOSABLE_ENV_NAMES };
