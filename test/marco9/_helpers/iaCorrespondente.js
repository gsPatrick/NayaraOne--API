'use strict';

// Apoio dos testes da NAY Correspondente (M9-D039): agente provisionado pela definição de código e ativado pelo ciclo normal, casos de
// financiamento com checklist e simulações conhecidos, e o orquestrador com o provider sandbox. Banco descartável, nayara_runtime, rollback.

const agents = require('../../../src/features/ai/agents');
const { AiOrchestrator } = require('../../../src/features/ai/orchestrator');
const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const { provisionAgentVersion, installGoldenCases } = require('../../../src/features/ai/agents/kit');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const { avaliar } = require('./iaAvaliacao');
const { DEFINITION, CODE, GOLDEN_CASES, registerNayCorrespondente } = require('../../../src/features/ai/agents/nay_correspondente');
const financingCases = require('../../../src/features/correspondent/cases/financingCases.service');
const caseDocuments = require('../../../src/features/correspondent/cases/caseDocuments.service');
const { Person } = require('../../../src/models');
const { carregarPessoas, ctxDe, q, run, uid } = require('../../helpers/aiAgents');
const { criarOrcamento, AGORA } = require('./iaOrcamento');

const FIXO = () => AGORA.getTime();
const PERMS = ['ai:use', 'correspondent:read'];

const como = (tenant, userId, ...permissions) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId, permissions });
const svc = new AiEvaluationService();

/**
 * Agente NAY_CORRESPONDENTE pelo ciclo completo de um agente de alto impacto: versão da empresa criada da definição (DRAFT), golden
 * cadastrado, avaliação golden e adversarial (suíte ALL) verde, homologação da versão e da avaliação por pessoas diferentes e ativação
 * por outra. `perms` são as permissões de quem pergunta; `deps` substitui dependências do orquestrador.
 */
async function cenario(tenant, tx, { perms = PERMS, deps = {}, orcamento = true } = {}) {
  registerNayCorrespondente(); // só este agente: os demais pacotes têm os seus próprios testes
  registerAiAdapters();
  await carregarPessoas();
  const registry = await buildDefaultRegistry();
  const [criador, disparador, homologador, avaliador, ativador] = [0, 1, 2, 3, 4].map(() => ctxDe(tenant).userId);
  const draft = await provisionAgentVersion(como(tenant, criador), DEFINITION, tx);
  await installGoldenCases(como(tenant, criador), CODE, GOLDEN_CASES, tx);
  const ev = await avaliar(svc, como(tenant, disparador, 'ai:evaluate'), tx, { agentCode: CODE, suite: 'all', agentVersion: draft.version });
  if (ev.status !== 'PASSED') throw new Error(`avaliação do golden não passou: ${JSON.stringify({ status: ev.status, metrics: ev.metrics, falhas: (ev.items || []).filter((i) => !i.passed).map((i) => [i.caseId, i.expected, i.actualSummary]) })}`);
  await agents.homologate(como(tenant, homologador), CODE, draft.version, {}, tx);
  await svc.homologate(como(tenant, avaliador, 'ai:evaluate'), ev.id, { note: 'Golden e adversarial conferidos.' }, tx);
  const dono = como(tenant, ativador);
  await agents.activate(dono, CODE, draft.version, tx);
  if (orcamento) await criarOrcamento(dono, tx, { agentCode: CODE, limit: '500.00' });
  const auth = { userId: ativador, groupId: tenant.groupId, companyId: tenant.companyId, permissions: perms, roles: ['TESTE'] };
  const orch = new AiOrchestrator({ toolRegistry: registry, clock: FIXO, ...deps });
  return { tenant, code: CODE, registry, auth, orch, tx, ctx: dono, version: draft.version, evaluation: ev, pessoas: { criador, disparador, homologador, avaliador, ativador } };
}

/** Uma consulta pelo orquestrador; `over` troca taskType, finalidade ou as permissões (`over.auth`). */
const rodar = (c, texto, over = {}) => c.orch.run({ agentCode: c.code, purpose: 'Acompanhar o financiamento', input: texto, taskType: 'consulta', ...over }, over.auth || c.auth, c.tx);

/** Caso de financiamento do provider `sandbox` com um proponente. */
async function criarCaso(tenant, tx) {
  const pessoa = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente M9D039 ${uid().slice(0, 8)}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: tx });
  return financingCases.createFinancingCase({ groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }] }, tenant.userId, tx);
}

const exigir = (caso, tenant, tx, documentType) => caseDocuments.createRequirement(caso.id, { documentType }, tenant.userId, { groupId: tenant.groupId, companyId: tenant.companyId }, tx);

/** Simulação já registrada, com valores conhecidos (gravada direto: o teste confere o que a NAY lê, não o cálculo do provider). */
async function simulacao(caso, tenant, tx, { provider = 'sandbox', amount, termMonths, monthlyPayment, rate = null }) {
  await run(
    `INSERT INTO correspondent.simulations (id, group_id, company_id, financing_case_id, provider_code, amount, term_months, monthly_payment, rate, request_snapshot, response_snapshot)
     VALUES (:id, :g, :c, :caso, :provider, :amount, :termMonths, :monthlyPayment, :rate, '{}'::jsonb, '{}'::jsonb)`,
    { id: uid(), g: tenant.groupId, c: tenant.companyId, caso: caso.id, provider, amount, termMonths, monthlyPayment, rate }, tx
  );
}

/** Envelhece o caso, o checklist e as simulações: o caso fica sem atividade há `dias` dias. */
async function envelhecer(caso, dias, tx) {
  for (const sql of [
    'UPDATE correspondent.financing_cases SET updated_at = now() - make_interval(days => :dias) WHERE id = :id',
    'UPDATE correspondent.case_requirements SET updated_at = now() - make_interval(days => :dias) WHERE financing_case_id = :id',
    'UPDATE correspondent.simulations SET created_at = now() - make_interval(days => :dias) WHERE financing_case_id = :id',
  ]) await run(sql, { dias, id: caso.id }, tx);
}

const lerRun = async (id, tx) => (await q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const chamadas = (runId, tx) => q('SELECT tool_name, status, blocked_reason FROM ai.tool_calls WHERE run_id = :runId ORDER BY seq', { runId }, tx);
const fontes = (runId, tx) => q('SELECT * FROM ai.ai_sources WHERE ai_run_id = :runId ORDER BY retrieved_at, id', { runId }, tx);
const recomendacoes = async (tx) => (await q('SELECT count(*)::int AS n FROM ai.ai_recommendations', {}, tx))[0].n;

module.exports = { cenario, como, svc, rodar, criarCaso, exigir, simulacao, envelhecer, lerRun, chamadas, fontes, recomendacoes, PERMS, FIXO, q, uid };
