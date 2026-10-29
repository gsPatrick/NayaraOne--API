'use strict';

const { AiToolCall } = require('../../../models');
const E = require('./toolCalls.errors');
const { toToolCall } = require('./toolCalls.mapper');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chamadas de ferramenta de um run, na ordem da execução. Só `ai:audit` lê (as de toda a empresa). Run de outra empresa ou
 * inexistente: lista vazia, igual (a RLS não deixa ver; nada revela existência).
 */
async function listToolCallsByRun(ctx, runId, transaction) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
  if (!(ctx.permissions || []).includes('ai:audit')) throw E.denied();
  if (!UUID_RE.test(String(runId))) throw E.notFound();
  const rows = await AiToolCall.findAll({ where: { runId, companyId: ctx.companyId }, order: [['seq', 'ASC']], transaction });
  return rows.map(toToolCall);
}

module.exports = { listToolCallsByRun };
