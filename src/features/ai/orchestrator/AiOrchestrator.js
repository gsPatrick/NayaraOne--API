'use strict';

const { executeRun, openRunPhase } = require('./flow/flow.run');
const { resolveDeps } = require('./flow/flow.deps');
const { assertNotInsideRun } = require('./flow/flow.reentrancy');

/**
 * AiOrchestrator (M9-D020) — o maestro do run da NAY: recebe a pessoa, a finalidade e o pedido; resolve a versão do agente, o modelo
 * permitido e o orçamento; busca fontes autorizadas; monta o prompt com tudo que é externo marcado como não confiável; pede a resposta
 * ou a tool; valida cada tool (allowlist, permissão, empresa, schema, injeção); para nas ações que exigem aprovação; executa as
 * seguras; registra run, fontes, tool calls e custo; e só devolve a resposta se estiver bem fundamentada.
 *
 * `new AiOrchestrator(deps).run(input, auth, transaction)`; `input`: { agentCode, purpose, input, taskType?, idempotencyKey?,
 * correlationId? }; `auth`: { userId, groupId, companyId, permissions, roles }; `transaction`: a do tenant (RLS). Dependências
 * substituíveis em ./flow/flow.deps.js. Não reentrante: tool que chama o orquestrador recebe 409 AI_ORCHESTRATOR_REENTRANT.
 */
class AiOrchestrator {
  constructor(deps = {}) {
    this.nome = 'AiOrchestrator';
    this.deps = deps;
  }

  /**
   * @param {RunInput} input @param {RunAuth} auth @param {any} transaction
   * @param {object} [opened] o que `open` devolveu: o run já aberto (e confirmado) numa transação anterior; sem ele o run nasce em `transaction`.
   */
  run(input, auth, transaction, opened = null) {
    return executeRun(input, auth, transaction, this.deps, opened);
  }

  /** Abre o run (passos 1 e 2 e a taxa por pessoa) em `transaction`, sem executar. Quem chama confirma a transação e depois chama `run(..., opened)`. */
  open(input, auth, transaction) {
    assertNotInsideRun();
    return openRunPhase(input, auth, transaction, resolveDeps(this.deps));
  }
}

module.exports = { AiOrchestrator };
