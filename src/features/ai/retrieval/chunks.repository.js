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

const findByIds = (ctx, ids, transaction) => AiChunk.findAll({ where: { ...own(ctx), id: ids, status: 'ACTIVE' }, transaction });

/** Chunks em qualquer estado (só para registrar a fonte não vigente que casou com a pergunta). */
const findAnyByIds = (ctx, ids, transaction) => AiChunk.findAll({ where: { ...own(ctx), id: ids }, transaction });

/** Passa para EXPIRED os chunks ACTIVE cuja vigência terminou em `now` (job diário, M9-D024). Devolve quantos. */
async function expireEnded(ctx, now, transaction) {
  const [n] = await AiChunk.update({ status: 'EXPIRED' }, { where: { ...own(ctx), status: 'ACTIVE', effectiveUntil: { [Op.lte]: now } }, transaction });
  return n;
}

/** Fontes com chunk ACTIVE (para a reconciliação): [{ sourceType, sourceId }]. */
async function activeSources(ctx, transaction) {
  const rows = await AiChunk.findAll({ attributes: ['sourceType', 'sourceId'], where: { ...own(ctx), status: 'ACTIVE' }, group: ['source_type', 'source_id'], raw: true, transaction });
  return rows.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId }));
}

/** Um chunk ACTIVE da fonte (todos têm os mesmos metadados copiados da origem). */
const sampleActive = (ctx, sourceType, sourceId, transaction) => AiChunk.findOne({ where: { ...own(ctx), sourceType, sourceId, status: 'ACTIVE' }, transaction });

/** Atualiza os metadados copiados da origem dos chunks ACTIVE da fonte. Devolve quantos mudaram de fato. */
async function updateMetadata(ctx, sourceType, sourceId, patch, transaction) {
  const [n] = await AiChunk.update(patch, { where: { ...own(ctx), sourceType, sourceId, status: 'ACTIVE' }, transaction });
  return n;
}

module.exports = { insertAll, supersedeOlder, retractSource, findByIds, findAnyByIds, expireEnded, activeSources, sampleActive, updateMetadata };
