'use strict';

// Apoio dos testes com banco (não é teste): tentativa dentro de SAVEPOINT.
const { sequelize } = require('../../../src/models');

/** Roda um SQL que deve falhar dentro de um SAVEPOINT (a transação do teste continua utilizável) e devolve a mensagem do erro, ou null se não falhou. */
async function dbError(tx, sql, replacements) {
  await sequelize.query('SAVEPOINT tentativa', { transaction: tx });
  try {
    await sequelize.query(sql, { transaction: tx, replacements });
    return null;
  } catch (err) {
    return String((err.original && err.original.message) || err.message);
  } finally {
    await sequelize.query('ROLLBACK TO SAVEPOINT tentativa', { transaction: tx });
  }
}

module.exports = { dbError };
