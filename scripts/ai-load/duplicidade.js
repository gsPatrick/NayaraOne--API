'use strict';

/**
 * M9-D046 — fase 3 da carga: a MESMA tool call e a MESMA aprovação enviadas por várias conexões ao mesmo tempo. Uma execução só: uma proposta e uma
 * linha de tool call; um pagamento, com as demais aprovações devolvendo replayed.
 */
const { comoTenant, F } = require('./ambiente');
const approval = require('../../src/features/ai/approval');
const { createToolCallRecorder } = require('../../src/features/ai/tools/toolCallRecorder');
const { createProposeAction } = require('../../src/features/ai/tools/proposals');
const { executeTool } = require('../../src/features/ai/tools/toolExecutor');
const { buildUserContext } = require('../../src/features/ai/orchestrator/executionContext');
const { partes } = require('../../test/marco9/_helpers/iaToolCalls');
const { LIMITES, ctxAprovador, contar, argsPagamento, setParam } = require('../../test/marco9/_helpers/iaAprovacao');
const { propor } = require('../../test/marco9/_helpers/iaAprovacaoFluxo');

/** A tool call de proposta com sequência fixa (a mesma chamada reenviada): o registro (M9-D006) deixa uma só linha. */
function chamarProposta(tenant, tx, c) {
  const execCtx = buildUserContext({ userId: c.solicitante, groupId: tenant.groupId, companyId: tenant.companyId, roles: ['T'], permissions: ['finance:create'] }, { correlationId: 'corr-carga', runId: c.runId });
  return executeTool({
    registry: c.registry.executorMap(), toolName: 'finance.proposePayment', input: argsPagamento(c), contextParts: partes(tenant, { auth: { userId: c.solicitante, permissions: ['finance:create'] } }),
    recorder: createToolCallRecorder({ ctx: { groupId: tenant.groupId, companyId: tenant.companyId, userId: c.solicitante }, transaction: tx, runId: c.runId }),
    proposeAction: createProposeAction({ registry: c.registry, execCtx, agent: c.agent, runId: c.runId, transaction: tx }), argsLimits: LIMITES, transaction: tx, seq: 1,
  });
}

async function faseDuplicidade(tenant, volume) {
  const { c, id } = await comoTenant(tenant, (tx) => propor(tenant, tx));
  const ctx = ctxAprovador(tenant, c.aprovador);
  // A mesma tool call (mesmo run, mesma sequência, mesmos argumentos) por N conexões.
  const chamadas = await Promise.allSettled(Array.from({ length: volume.repeticoesDaToolCall }, () => comoTenant(tenant, (tx) => chamarProposta(tenant, tx, c))));
  const propostas = await comoTenant(tenant, (tx) => contar('ai.ai_recommendations', 'ai_run_id = :r', { r: c.runId }, tx));
  const linhas = await comoTenant(tenant, (tx) => contar('ai.tool_calls', 'run_id = :r', { r: c.runId }, tx));
  // A mesma aprovação por N conexões.
  const aceites = await Promise.allSettled(Array.from({ length: volume.aceitesSimultaneos }, () => comoTenant(tenant, (tx) => approval.approveRecommendation(ctx, id, {}, tx))));
  const ok = aceites.filter((a) => a.status === 'fulfilled').map((a) => a.value);
  const pagamentos = await comoTenant(tenant, (tx) => contar('finance.payment_intents', 'financial_entry_id = :e', { e: c.entry.id }, tx));
  await comoTenant(tenant, (tx) => setParam(tenant, tx, 'ia.financeira.permitir_proposta_pagamento', false));
  return {
    agentCode: c.agent.code,
    chamadasRepetidas: chamadas.length,
    propostas,
    linhasDeToolCall: linhas,
    aceitesEnviados: aceites.length,
    aceitesConcluidos: ok.length,
    execucoesReais: ok.filter((r) => r.replayed === false).length,
    replays: ok.filter((r) => r.replayed === true).length,
    pagamentos,
    recusados: aceites.filter((a) => a.status === 'rejected').map((a) => (a.reason && a.reason.code) || 'ERRO'),
  };
}

module.exports = { faseDuplicidade, F };
