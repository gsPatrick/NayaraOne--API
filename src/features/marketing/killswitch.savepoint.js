'use strict';

const crypto = require('node:crypto');
const { sequelize } = require('../../models');

/**
 * Roda `fn` num SAVEPOINT de nome único dentro da transação do chamador: se `fn` falhar, desfaz só o que ela fez e a transação segue utilizável (o erro volta ao chamador). Nome único
 * porque o nome gerado pelo Sequelize para transações aninhadas pode repetir e um ROLLBACK TO desfaria o ponto errado. Sem transação não há onde abrir o ponto: o erro volta.
 */
async function withSavepoint(transaction, fn) {
  if (!transaction) throw new Error('kill switch: a leitura exige a transação da empresa (RLS).');
  const name = `ks_${crypto.randomBytes(6).toString('hex')}`;
  await sequelize.query(`SAVEPOINT ${name}`, { transaction });
  try {
    const out = await fn(transaction);
    await sequelize.query(`RELEASE SAVEPOINT ${name}`, { transaction });
    return out;
  } catch (err) {
    await sequelize.query(`ROLLBACK TO SAVEPOINT ${name}`, { transaction });
    await sequelize.query(`RELEASE SAVEPOINT ${name}`, { transaction });
    throw err;
  }
}

module.exports = { withSavepoint };
