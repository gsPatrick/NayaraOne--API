'use strict';

const { Op } = require('sequelize');
const { AiIngestion } = require('../../../models');
const { acquireIngestionLock } = require('../readmodels/ragSupport.readmodel');

/** Acesso a ai.ingestions pelos modelos. Sempre dentro da transação do tenant (RLS FORCE decide o que a empresa enxerga). */
const own = (ctx) => ({ companyId: ctx.companyId });
const OPEN = { [Op.notIn]: ['REJECTED', 'FAILED'] };

const lockSource = (ctx, kind, sourceId, transaction) => acquireIngestionLock(ctx.companyId, kind, sourceId, transaction);

const findById = (ctx, id, transaction) => AiIngestion.findOne({ where: { id, ...own(ctx) }, transaction });

/** Última ingestão INDEXED da fonte (a versão vigente do índice). */
const findIndexed = (ctx, kind, sourceId, transaction) => AiIngestion.findOne({
  where: { ...own(ctx), sourceKind: kind, sourceId, status: 'INDEXED' }, order: [['sourceVersion', 'DESC']], transaction,
});

/** Ingestão em andamento ou concluída (nem REJECTED nem FAILED) de uma versão da fonte. */
const findOpenVersion = (ctx, kind, sourceId, version, transaction) => AiIngestion.findOne({
  where: { ...own(ctx), sourceKind: kind, sourceId, sourceVersion: version, status: OPEN }, transaction,
});

/** Próxima versão da fonte: maior já usada (inclusive por rejeição) + 1. */
async function nextVersion(ctx, kind, sourceId, transaction) {
  const max = await AiIngestion.max('sourceVersion', { where: { ...own(ctx), sourceKind: kind, sourceId }, transaction });
  return (Number.isInteger(max) ? max : 0) + 1;
}

const create = (ctx, v, transaction) => AiIngestion.create({
  groupId: ctx.groupId, companyId: ctx.companyId, sourceKind: v.sourceKind, sourceRef: v.sourceRef, sourceId: v.sourceId, status: v.status || 'PENDING',
  step: v.step || 'AUTHORIZE', errorCode: v.errorCode || null, contentHash: v.contentHash || null, classification: v.classification || null,
  sourceVersion: v.sourceVersion, secretsRemoved: v.secretsRemoved || 0, activeContentDiscarded: v.activeContentDiscarded || 0, chunksCount: v.chunksCount || 0,
  createdBy: ctx.userId || null, finishedAt: v.finishedAt || null,
}, { transaction });

/** Linhas PENDING da empresa, mais antigas primeiro (fila do job). */
const listPending = (ctx, limit, transaction) => AiIngestion.findAll({
  where: { ...own(ctx), status: 'PENDING' }, order: [['created_at', 'ASC'], ['id', 'ASC']], limit, transaction,
});

module.exports = { lockSource, findById, findIndexed, findOpenVersion, nextVersion, create, listPending };
