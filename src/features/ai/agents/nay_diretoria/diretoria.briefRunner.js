'use strict';

/**
 * M9-D693 (3.7) — a NAY Diretoria escreve o briefing executivo pelo orquestrador do Bloco A (registro de run, custo, orçamento, fallback).
 * Quem chama é o JOB do BI, não uma pessoa: o contexto é a identidade de serviço ativa do agente na empresa (somente leitura, M9-D017),
 * montada pelo servidor. O BI entrega o pedido já com os dados e as regras (analytics/briefs); este arquivo só liga o BI ao agente, e
 * assim o BI não importa o módulo de IA. Falha de provider, orçamento ou identidade de serviço volta como `{ ok: false, error }` ou lança:
 * quem chamou registra o briefing como FAILED, sem texto inventado.
 */
const { AiOrchestrator } = require('../../orchestrator');
const { loadChannelContext } = require('../../orchestrator/executionContext');
const { CODE } = require('./diretoria.policy');

const PURPOSE = 'Briefing executivo diário ou semanal da diretoria';
const TASK_TYPE = 'briefing_executivo';

/** `deps` substitui as dependências do orquestrador (testes). Devolve `async (request, transaction) => outcome do orquestrador`. */
function createBriefAgentRunner(deps = {}) {
  return async function runBriefAgent({ groupId, companyId, instruction, correlationId, idempotencyKey }, transaction) {
    const service = await loadChannelContext({ groupId, companyId }, CODE, null, transaction, { correlationId });
    const auth = { userId: null, groupId, companyId, permissions: [...service.permissions], roles: [], serviceContext: service };
    return new AiOrchestrator(deps).run({ agentCode: CODE, purpose: PURPOSE, input: instruction, taskType: TASK_TYPE, idempotencyKey, correlationId }, auth, transaction);
  };
}

module.exports = { createBriefAgentRunner, PURPOSE, TASK_TYPE };
