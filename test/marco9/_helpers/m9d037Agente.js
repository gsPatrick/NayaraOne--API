'use strict';

// Apoio dos testes da NAY Obras e da NAY Jurídica (M9-D037, M9-D038): a empresa recebe a versão do PADRÃO DO SISTEMA do agente (cópia pelo
// serviço da M9-D004), homologada por uma pessoa e ativada por outra, com orçamento; o orquestrador roda com o provider sandbox.
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const agents = require('../../../src/features/ai/agents');
const { AiOrchestrator } = require('../../../src/features/ai/orchestrator');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const { carregarPessoas, ctxDe, q, uid } = require('../../helpers/aiAgents');
const { criarOrcamento, AGORA } = require('./iaOrcamento');

const FIXO = () => AGORA.getTime();

/** Ativa na empresa a versão do padrão do sistema de `code`. Devolve o cenário do orquestrador. */
async function ativarAgente(tenant, tx, code, { perms, limit = '500.00', deps = {}, params = {} } = {}) {
  registerAiAdapters();
  await carregarPessoas();
  const registry = await buildDefaultRegistry();
  const ctx = ctxDe(tenant);
  await upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, ctx, ctx.userId, tx);
  for (const [k, v] of Object.entries(params)) await upsertSetting(k, v, ctx, ctx.userId, tx);
  const criada = await agents.createVersion(ctx, code, {}, tx);
  if (criada.criticality === 'CRITICAL') await avaliarEHomologar(tenant, tx, code, criada.version); // agente de alto impacto: a dispensa não vale
  await agents.homologate(ctxDe(tenant), code, criada.version, {}, tx);
  await agents.activate(ctx, code, criada.version, tx);
  await criarOrcamento({ groupId: tenant.groupId, companyId: tenant.companyId, userId: ctx.userId }, tx, { agentCode: code, limit });
  const auth = { userId: ctx.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: perms, roles: ['TESTE'] };
  const orch = new AiOrchestrator({ toolRegistry: registry, clock: FIXO, ...deps });
  return { tenant, code, registry, auth, orch, tx, ctx, agent: criada };
}

/** Agente de alto impacto: avaliação verde (suíte completa, sandbox) disparada por uma pessoa e homologada por outra. */
async function avaliarEHomologar(tenant, tx, code, agentVersion) {
  const svc = new AiEvaluationService();
  const como = () => ({ ...ctxDe(tenant), permissions: ['ai:evaluate'] });
  const disparador = como();
  const { evaluation } = await svc.request(disparador, { agentCode: code, suite: 'all', agentVersion }, tx);
  await svc.processQueued(disparador, tx, { evaluationId: evaluation.id });
  return svc.homologate(como(), evaluation.id, { note: 'Revisado pelo responsável (teste).' }, tx);
}

/** Uma consulta. `over` troca campos do pedido (taskType, subject) e `auth`. */
const perguntar = (c, texto, over = {}) => c.orch.run({ agentCode: c.code, purpose: 'Consulta de teste', input: texto, taskType: 'consulta', ...over }, over.auth || c.auth, c.tx);

const chamadas = (runId, tx) => q('SELECT * FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const contar = async (sql, rep, tx) => (await q(sql, rep, tx))[0].n;

module.exports = { ativarAgente, perguntar, chamadas, contar, q, uid, FIXO, AGORA };
