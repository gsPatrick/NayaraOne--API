'use strict';

const { AiRun, AiSource } = require('../../../../models');
const E = require('./runs.errors');
const V = require('./runs.validation');
const { toRun, toSource } = require('./runs.mapper');

/**
 * Lê um run com as fontes. `ai:audit` lê qualquer run da empresa; `ai:read` só os próprios; quem não tem nenhuma das duas
 * recebe 403. Run de outra empresa, de outra pessoa (sem ai:audit) ou inexistente: 404 igual, sem revelar existência.
 */
async function getRun(ctx, id, transaction) {
  V.ctxOk(ctx);
  const permissions = ctx.permissions || [];
  const audit = permissions.includes('ai:audit');
  if (!audit && !permissions.includes('ai:read')) throw E.denied();
  if (!V.isUuid(id)) throw E.notFound();
  const row = await AiRun.findOne({ where: { id, companyId: ctx.companyId }, transaction });
  if (!row || (!audit && row.userId !== ctx.userId)) throw E.notFound();
  const sources = await AiSource.findAll({ where: { aiRunId: row.id, companyId: ctx.companyId }, order: [['retrievedAt', 'ASC'], ['id', 'ASC']], transaction });
  return { ...toRun(row), sources: sources.map(toSource) };
}

module.exports = { getRun };
