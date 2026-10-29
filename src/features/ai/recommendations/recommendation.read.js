'use strict';

const { AiRecommendation } = require('../../../models');
const E = require('./recommendation.errors');
const V = require('./recommendation.validation');
const C = require('./recommendation.constants');
const P = require('./recommendation.permissions');
const { toRecommendation } = require('./recommendation.mapper');
const { readRecommendationParams } = require('./recommendation.params');

/** Lista recomendações: ai:audit/ai:approve veem a empresa; ai:read vê só as dirigidas à pessoa. Limite = parâmetro da empresa. */
async function listRecommendations(ctx, filters = {}, transaction) {
  V.ctxOk(ctx);
  const scope = P.visibility(ctx);
  const params = await readRecommendationParams(ctx, transaction);
  if (filters.status !== undefined && !C.STATUSES.includes(filters.status)) throw E.invalid('Estado inválido.', { permitidos: C.STATUSES });
  const where = { companyId: ctx.companyId };
  if (scope === 'OWN') where.targetUserId = ctx.userId;
  if (filters.status) where.status = filters.status;
  if (filters.targetUserId && scope === 'COMPANY') where.targetUserId = filters.targetUserId;
  const asked = Number(filters.limit);
  const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, params.listMax) : params.listMax;
  const rows = await AiRecommendation.findAll({ where, order: [['created_at', 'DESC'], ['id', 'ASC']], limit, transaction });
  return rows.map(toRecommendation);
}

/** Uma recomendação; a que não é da empresa (ou não é dirigida à pessoa, no escopo próprio) é 404 sem revelar existência. */
async function getRecommendation(ctx, id, transaction) {
  V.ctxOk(ctx);
  const scope = P.visibility(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  const where = { id, companyId: ctx.companyId, ...(scope === 'OWN' ? { targetUserId: ctx.userId } : {}) };
  const row = await AiRecommendation.findOne({ where, transaction });
  if (!row) throw E.notFound();
  return toRecommendation(row);
}

module.exports = { listRecommendations, getRecommendation };
