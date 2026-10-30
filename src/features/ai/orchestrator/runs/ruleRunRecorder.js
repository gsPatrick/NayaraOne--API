'use strict';

const { Op } = require('sequelize');
const { AiRun, AiAgent } = require('../../../../models');
const V = require('./runs.validation');
const E = require('./runs.errors');
const C = require('./runs.constants');
const { toRun } = require('./runs.mapper');
const { publishRunEvent, auditRun } = require('./runEvents');
const { guarded } = require('./runLifecycle');
const { sanitizeSummary, sanitizeToolCalls, summaryLimit } = require('../../audit/auditSanitizer');
const { observe } = require('../../observability/observe');

/**
 * Versão do agente a gravar no run de uma NAY determinística (sem modelo): a ACTIVE da empresa, senão a ACTIVE do sistema,
 * senão a versão mais recente não aposentada (empresa antes do sistema). Código sem agente cadastrado (ex.: NAY_ESTOQUE_OCR)
 * devolve null: o run continua válido, só sem agent_id.
 */
async function findAgentStamp(ctx, code, transaction) {
  const rows = await AiAgent.findAll({ where: { code, status: { [Op.ne]: 'RETIRED' }, [Op.or]: [{ companyId: ctx.companyId }, { companyId: null }] }, transaction });
  if (!rows.length) return null;
  const rank = (a) => (a.status === 'ACTIVE' ? 2 : 0) + (a.companyId ? 1 : 0);
  rows.sort((a, b) => (rank(b) - rank(a)) || (b.version - a.version));
  return { agentId: rows[0].id, agentVersion: rows[0].version };
}

/**
 * Registra, já finalizado, o run de uma NAY por regra (zero custo, zero token, `routing_path = RULE`): as cinco NAYs
 * determinísticas (Financeira, Estoque, Estoque OCR, Obras/Compras, Jurídica) gravam por aqui. Evento ai.run.completed e
 * auditoria na mesma transação. Entrada: { agentName, inputSummary, outputSummary, toolCallsJson, groundingStatus, purpose }.
 */
async function recordRuleRun(ctx, data, transaction) {
  V.ctxOk(ctx);
  const grounding = data.groundingStatus === undefined ? 'GROUNDED' : data.groundingStatus;
  if (!C.GROUNDING.includes(grounding)) throw E.invalid('Estado de aterramento inválido.');
  return guarded(async () => {
    const stamp = await findAgentStamp(ctx, data.agentName, transaction);
    const limit = await summaryLimit(ctx, transaction);
    const now = new Date();
    const row = await AiRun.create({
      groupId: ctx.groupId, companyId: ctx.companyId, userId: ctx.userId || null, agentName: data.agentName, agentId: stamp ? stamp.agentId : null,
      agentVersion: stamp ? stamp.agentVersion : null, purpose: data.purpose || null, inputSummary: sanitizeSummary(data.inputSummary, limit),
      toolCallsJson: sanitizeToolCalls(data.toolCallsJson) || null, outputSummary: sanitizeSummary(data.outputSummary, limit), status: 'COMPLETED', routingPath: 'RULE',
      groundingStatus: grounding, tokensIn: 0, tokensOut: 0, costAmount: '0.000000', startedAt: now, finishedAt: now,
      createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
    }, { transaction });
    const run = toRun(row);
    await auditRun(ctx, 'ai.run.recorded', run, null, 'Execução determinística da NAY registrada.', transaction);
    await publishRunEvent(ctx, run, transaction);
    await observe(ctx, transaction, (m) => m.runFinished(run)); // M9-D047
    return run;
  });
}

module.exports = { recordRuleRun, findAgentStamp };
