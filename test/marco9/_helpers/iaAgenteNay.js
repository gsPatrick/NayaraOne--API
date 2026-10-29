'use strict';

// Ciclo completo de um agente da NAY de alto impacto para os testes (M9-D039 em diante): versão da empresa criada da definição de código
// (DRAFT), golden cadastrado, avaliação golden + adversarial (suíte ALL) verde, homologação da versão e da avaliação por pessoas
// diferentes, ativação por outra pessoa e orçamento. Banco descartável, nayara_runtime, rollback.

const agents = require('../../../src/features/ai/agents');
const { AiOrchestrator } = require('../../../src/features/ai/orchestrator');
const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const { provisionAgentVersion, installGoldenCases } = require('../../../src/features/ai/agents/kit');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const { avaliar } = require('./iaAvaliacao');
const { carregarPessoas, q } = require('../../helpers/aiAgents');
const { criarOrcamento, AGORA } = require('./iaOrcamento');

const FIXO = () => AGORA.getTime();
const como = (tenant, userId, ...permissions) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId, permissions });
const svc = new AiEvaluationService();

/**
 * `pacote`: { CODE, DEFINITION, GOLDEN_CASES, register }. `perms` são as permissões de quem pergunta; `deps` substitui dependências do
 * orquestrador. Devolve { tenant, code, registry, auth, orch, tx, ctx, version, evaluation, pessoas }.
 */
async function ativarAgente(tenant, tx, pacote, { perms, deps = {}, orcamento = true } = {}) {
  pacote.register(); // só este agente: os demais pacotes têm os seus próprios testes
  registerAiAdapters();
  await carregarPessoas();
  const registry = await buildDefaultRegistry();
  // Cinco pessoas diferentes. Quem pergunta e ativa é membro da empresa: a recomendação da NAY é dirigida a ele e só vale para membro.
  const usuarios = (await q('SELECT id FROM core.users ORDER BY email LIMIT 6', {}, tx)).map((r) => r.id);
  // Prefere quem não é administrador de sistema: o administrador lê qualquer arquivo sem dono e esconderia as recusas de permissão.
  const membros = new Map((await q(
    "SELECT m.user_id, (r.is_system AND r.name = 'ADMIN') AS admin FROM core.user_memberships m JOIN core.roles r ON r.id = m.role_id WHERE m.company_id = :c AND m.status = 'ACTIVE'",
    { c: tenant.companyId }, tx
  )).map((r) => [r.user_id, r.admin]));
  const ativador = usuarios.find((id) => membros.has(id) && !membros.get(id)) || usuarios.find((id) => membros.has(id));
  const [criador, disparador, homologador, avaliador] = usuarios.filter((id) => id !== ativador);
  const draft = await provisionAgentVersion(como(tenant, criador), pacote.DEFINITION, tx);
  await installGoldenCases(como(tenant, criador), pacote.CODE, pacote.GOLDEN_CASES, tx);
  const ev = await avaliar(svc, como(tenant, disparador, 'ai:evaluate'), tx, { agentCode: pacote.CODE, suite: 'all', agentVersion: draft.version });
  if (ev.status !== 'PASSED') {
    throw new Error(`avaliação do golden não passou: ${JSON.stringify({ status: ev.status, metrics: ev.metrics, falhas: (ev.items || []).filter((i) => !i.passed).map((i) => [i.caseId, i.expected, i.actualSummary]) })}`);
  }
  await agents.homologate(como(tenant, homologador), pacote.CODE, draft.version, {}, tx);
  await svc.homologate(como(tenant, avaliador, 'ai:evaluate'), ev.id, { note: 'Golden e adversarial conferidos.' }, tx);
  const dono = como(tenant, ativador);
  await agents.activate(dono, pacote.CODE, draft.version, tx);
  if (orcamento) await criarOrcamento(dono, tx, { agentCode: pacote.CODE, limit: '500.00' });
  const auth = { userId: ativador, groupId: tenant.groupId, companyId: tenant.companyId, permissions: perms, roles: ['TESTE'] };
  const orch = new AiOrchestrator({ toolRegistry: registry, clock: FIXO, ...deps });
  return { tenant, code: pacote.CODE, registry, auth, orch, tx, ctx: dono, version: draft.version, evaluation: ev, pessoas: { criador, disparador, homologador, avaliador, ativador } };
}

/** Uma consulta pelo orquestrador; `over` troca taskType, finalidade ou as permissões (`over.auth`). */
const rodar = (c, texto, over = {}) => c.orch.run({ agentCode: c.code, purpose: over.purpose || 'Consulta de teste', input: texto, taskType: 'consulta', ...over }, over.auth || c.auth, c.tx);

module.exports = { ativarAgente, rodar, como, svc, FIXO };
