'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Quem é o usuário do banco desta transação e se ele é superusuário ou ignora RLS (M9-D017: a NAY nunca roda assim). */
async function readConnectionIdentity(transaction) {
  const [row] = await sequelize.query(
    'SELECT current_user AS "currentUser", r.rolsuper AS "rolsuper", r.rolbypassrls AS "rolbypassrls" FROM pg_roles r WHERE r.rolname = current_user',
    { transaction, type: QueryTypes.SELECT }
  );
  return row;
}

module.exports = { readConnectionIdentity };
