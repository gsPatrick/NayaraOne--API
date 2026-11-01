'use strict';

const { Op } = require('sequelize');
const { IntegrationConnection } = require('../../../models');

/**
 * Referência do cofre para uma connection migrada (M9-D202 regra 6: a referência não é compartilhada). Devolve `base` quando nenhuma outra connection da empresa a usa;
 * quando outra já a usa (várias connections do mesmo fornecedor, como depois de reativações), devolve `base` com o início do id da connection, que é único por connection.
 */
async function uniqueCanonicalRef(connection, base, transaction) {
  const outra = await IntegrationConnection.findOne({ where: { companyId: connection.companyId, secretRef: base, id: { [Op.ne]: connection.id } }, transaction });
  return outra ? `${base}-${String(connection.id).replace(/-/g, '').slice(0, 12)}` : base;
}

module.exports = { uniqueCanonicalRef };
