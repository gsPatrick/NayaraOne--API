'use strict';

const V = require('./evaluations.validation');
const E = require('./evaluations.errors');
const repo = require('./evaluations.repository');
const { toEvaluation, toItem } = require('./evaluations.mapper');

const LIST_MAX = 100;

/** Uma avaliação com os itens. Avaliação de outra empresa ou inexistente: 404 igual, sem revelar existência. */
async function getEvaluation(ctx, id, transaction) {
  V.ctxOk(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  const row = await repo.findOwn(ctx, id, transaction);
  if (!row) throw E.notFound();
  const items = await repo.itemsOf(ctx, row.id, transaction);
  return { ...toEvaluation(row), items: items.map(toItem) };
}

/** Lista as avaliações da empresa, da mais nova para a mais antiga; filtros opcionais por agente, versão e estado. */
async function listEvaluations(ctx, filters = {}, transaction) {
  V.ctxOk(ctx);
  const where = {};
  if (filters.agentCode) where.agentCode = String(filters.agentCode).trim().toUpperCase();
  if (filters.agentVersion) where.agentVersion = Number(filters.agentVersion);
  if (filters.status) where.status = String(filters.status).trim().toUpperCase();
  const asked = Number(filters.limit);
  const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, LIST_MAX) : 20;
  return (await repo.listOwn(ctx, where, limit, transaction)).map(toEvaluation);
}

module.exports = { getEvaluation, listEvaluations };
