'use strict';

// Apoio dos testes do AiOrchestrator (M9-D020): agente ATIVO pelo serviço da D004, orçamento, oportunidade, registro de tools e o
// orquestrador com o provider sandbox. Banco descartável, role nayara_runtime, rollback. O relógio é fixo no meio do mês do orçamento.

const assert = require('node:assert/strict');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const agents = require('../../../src/features/ai/agents');
const { AiOrchestrator } = require('../../../src/features/ai/orchestrator');
const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const { carregarPessoas, ctxDe, BASE_AGENT, q, uid } = require('../../helpers/aiAgents');
const { criarOportunidade } = require('./aiToolsEnv');
const { criarOrcamento, AGORA } = require('./iaOrcamento');

const FIXO = () => AGORA.getTime();
const PERMS = ['ai:use', 'crm:opportunities:read', 'crm:tasks:create', 'finance:read'];

/** Linha da allowlist (agent_tools) a partir da definição registrada: permissão, risco e aprovação vêm do registro. */
const linhaDeTool = (registry, nome) => {
  const def = registry.get(nome);
  const alto = ['HIGH', 'CRITICAL'].includes(def.riskLevel);
  return { toolName: nome, permissionCode: def.permissionCode, riskLevel: def.riskLevel, requiresHumanApproval: alto || def.requiresHumanApproval, enabled: true };
};

/**
 * Cenário padrão: agente ativo (código único), orçamento do agente, oportunidade, registro de tools (com as `extraDefs` de teste) e o
 * orquestrador. `agentOver` mexe na versão do agente (limites, modelPolicy, systemPolicy, criticidade); `deps` substitui dependências.
 */
async function cenario(tenant, tx, {
  tools = ['crm.getOpportunity'], extraDefs = [], agentOver = {}, perms = PERMS, limit = '500.00', orcamento = true, deps = {}, criticality,
} = {}) {
  registerAiAdapters();
  await carregarPessoas();
  const registry = await buildDefaultRegistry();
  extraDefs.forEach((d) => registry.register(d));
  const code = `T_${uid().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const ctx = ctxDe(tenant);
  await upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, ctx, ctx.userId, tx);
  await agents.createVersion(ctx, code, {
    ...BASE_AGENT, limits: {}, ...(criticality ? { criticality } : {}), ...agentOver, tools: tools.map((t) => linhaDeTool(registry, t)),
  }, tx);
  await agents.homologate(ctxDe(tenant), code, 1, {}, tx);
  await agents.activate(ctx, code, 1, tx);
  const dono = ctxDe(tenant);
  if (orcamento) await criarOrcamento({ groupId: tenant.groupId, companyId: tenant.companyId, userId: dono.userId }, tx, { agentCode: code, limit });
  const { opp } = await criarOportunidade(tenant, tx);
  const auth = { userId: dono.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: perms, roles: ['TESTE'] };
  const orch = new AiOrchestrator({ toolRegistry: registry, clock: FIXO, ...deps });
  return { tenant, code, registry, opp, auth, orch, tx, ctx: dono };
}

/** Uma consulta pelo orquestrador. `texto` é o que o usuário pergunta (as fixtures do sandbox vão aqui). */
const rodar = (c, texto, over = {}) => c.orch.run({ agentCode: c.code, purpose: 'Consulta de teste', input: texto, taskType: 'consulta', ...over }, over.auth || c.auth, c.tx);

const pedirOportunidade = (c) => `[[TOOL:crm.getOpportunity:{"opportunityId":"${c.opp.id}"}]]`;

const lerRun = async (id, tx) => (await q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const chamadas = (runId, tx) => q('SELECT * FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const fontes = (runId, tx) => q('SELECT * FROM ai.ai_sources WHERE ai_run_id = :runId ORDER BY retrieved_at, id', { runId }, tx);
const orcamentoDe = async (code, tx) => (await q('SELECT * FROM ai.budgets WHERE agent_code = :code', { code }, tx))[0];

/** O resultado é uma falha com o HTTP, o código e o estado do run esperados. */
function falhou(res, status, code, runStatus) {
  assert.equal(res.ok, false, `esperava falha ${code}, veio ok`);
  assert.equal(res.error.status, status, res.error.message);
  assert.equal(res.error.code, code);
  if (runStatus) assert.equal(res.status, runStatus);
  return res;
}

const passos = (res) => res.trace.map((s) => s.step);

module.exports = { cenario, rodar, pedirOportunidade, lerRun, chamadas, fontes, orcamentoDe, falhou, passos, linhaDeTool, PERMS, FIXO, q, uid };
