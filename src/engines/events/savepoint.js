'use strict';

const { randomUUID } = require('node:crypto');
const { sequelize } = require('../../models');

/**
 * Savepoint com nome ÚNICO. O Sequelize nomeia o savepoint aninhado como `<id>-sp-<n>` e `n` é a posição dentro do pai: um savepoint
 * aberto dentro de outro pode receber o MESMO nome do pai (ex.: o INSERT do outbox dentro do consumidor). No PostgreSQL o
 * `ROLLBACK TO` do pai então volta só até o savepoint mais novo e deixa para trás o que foi gravado entre os dois. Quem precisa de
 * "tudo ou nada" em escritas que publicam evento (projetores) usa esta função: a falha desfaz tudo o que o `work` gravou.
 */
async function withUniqueSavepoint(transaction, work) {
  const name = `sp_${randomUUID().replace(/-/g, '')}`;
  await sequelize.query(`SAVEPOINT ${name}`, { transaction });
  try {
    const result = await work(transaction);
    await sequelize.query(`RELEASE SAVEPOINT ${name}`, { transaction });
    return result;
  } catch (err) {
    await sequelize.query(`ROLLBACK TO SAVEPOINT ${name}`, { transaction });
    throw err;
  }
}

module.exports = { withUniqueSavepoint };
