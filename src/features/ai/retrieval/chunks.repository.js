'use strict';

const { Op } = require('sequelize');
const { AiChunk } = require('../../../models');

/** Acesso a ai.chunks pelos modelos (a consulta de busca é SQL e mora em readmodels/ragSupport). Dentro da transação do tenant. */
const own = (ctx) => ({ companyId: ctx.companyId });

/** Grava os chunks de uma versão. Quem chama já garantiu os metadados (chunks.write). */
const insertAll = (rows, transaction) => AiChunk.bulkCreate(rows, { transaction, validate: false });

/** A versão anterior da fonte (qualquer ACTIVE com versão menor) vira SUPERSEDED. Devolve quantos. */
async function supersedeOlder(ctx, sourceType, sourceId, version, transaction) {
  const [n] = await AiChunk.update({ status: 'SUPERSEDED' }, {
    where: { ...own(ctx), sourceType, sourceId, status: 'ACTIVE', sourceVersion: { [Op.lt]: version } }, transaction,
  });
  return n;
}

/** Retira da busca todos os chunks ACTIVE da fonte (`status` REVOKED, SUPERSEDED ou EXPIRED). */
async function retractSource(ctx, sourceType, sourceId, status, transaction, { exceptVersion } = {}) {
  const where = { ...own(ctx), sourceType, sourceId, status: 'ACTIVE' };
  if (exceptVersion) where.sourceVersion = { [Op.ne]: exceptVersion };
  const [n] = await AiChunk.update({ status }, { where, transaction });
  return n;
}

module.exports = { insertAll, supersedeOlder, retractSource };
