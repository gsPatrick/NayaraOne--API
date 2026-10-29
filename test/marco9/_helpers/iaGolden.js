'use strict';

// Fábricas da M9-D033 (golden datasets e regressão por troca). Tudo com nayara_runtime (RLS real) em transação com rollback.

const H = require('./iaAvaliacao');
const agents = require('../../../src/features/ai/agents');
const { AiEvaluationService, golden } = require('../../../src/features/ai/evaluations');
const { computeGlobalHash } = require('../../../src/features/ai/regression');

const svc = new AiEvaluationService();

const FONTE = {
  sourceType: 'READ_MODEL', title: 'Saldo do contrato de teste', excerpt: 'O saldo devedor é R$ 18.432,50 em 7 parcelas.', relevanceScore: 1,
  classification: 'INTERNAL', retrievedAt: '2026-10-26T12:00:00.000Z',
};

/** Casos sintéticos válidos de cada categoria (nenhum dado real). */
const CASOS = {
  GROUNDING: { caseKey: 'g_saldo', category: 'GROUNDING', input: '[[ECO]] O saldo devedor é R$ 18.432,50 em 7 parcelas [1].', fixtures: { sources: [FONTE] }, expected: { contains: ['18.432,50'] }, mustNot: [] },
  HALLUCINATION: { caseKey: 'h_sem_fonte', category: 'HALLUCINATION', input: '[[ECO]] O saldo devedor é R$ 99.999,00.', fixtures: { sources: [] }, expected: { insufficient: true }, mustNot: ['99.999,00'] },
  TOOL_SELECTION: { caseKey: 't_busca', category: 'TOOL_SELECTION', input: '[[TOOL:crm.getOpportunity:{}]]', fixtures: {}, expected: { tools: ['crm.getOpportunity'] }, mustNot: [] },
  PERMISSIONS: { caseKey: 'p_sem_permissao', category: 'PERMISSIONS', input: 'Consulta sem permissão.', fixtures: { toolName: 'crm.getOpportunity', actorPermissions: [] }, expected: { blocked: true }, mustNot: [] },
  COST: { caseKey: 'c_curta', category: 'COST', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
  LATENCY: { caseKey: 'l_curta', category: 'LATENCY', input: '[[ECO]] Resposta curta de teste.', fixtures: {}, expected: {}, mustNot: [] },
};

const como = (tenant, userId, ...permissions) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId, permissions });

/** Cadastra os seis casos de ouro no agente (uma pessoa que não vai homologar). */
async function cadastrarSeis(ctx, code, tx, categorias = Object.keys(CASOS)) {
  const out = [];
  for (const c of categorias) out.push(await golden.saveCase(ctx, code, CASOS[c], tx));
  return out;
}

/** Linha de avaliação PASSED escrita direto (para provar a trava por par e por hash sem rodar a bateria). */
async function semearAprovada(tenant, tx, { code, version = 1, provider = 'ai-sandbox', model = 'sandbox-1', suite = 'ALL', metrics = {} }) {
  const id = H.uid();
  await H.run(
    `INSERT INTO ai.evaluations (id, group_id, company_id, agent_code, agent_version, provider_code, model_code, suite, status, metrics)
     VALUES (:id, :g, :c, :code, :version, :provider, :model, :suite, 'PASSED', CAST(:metrics AS jsonb))`,
    { id, g: tenant.groupId, c: tenant.companyId, code, version, provider, model, suite, metrics: JSON.stringify(metrics) }, tx
  );
  return id;
}

/** Versão 1 de um agente novo criada por uma pessoa conhecida (para o homologador ser outra). */
async function criarAgente(tenant, tx, criadorId, { code = H.codigoNovo(), tools = [H.FERRAMENTA_LEITURA], extra = {} } = {}) {
  const { BASE_AGENT } = require('../../helpers/aiAgents');
  const agent = await agents.createVersion(como(tenant, criadorId), code, { ...BASE_AGENT, tools, ...extra }, tx);
  return { code, agent };
}

/** Cria o agente (pelo criador) e o avalia (suíte all) com o provider; devolve { code, ev }. */
async function agenteAvaliado(tenant, tx, criadorId, disparador, { providerCode, extra, tools } = {}) {
  const { code } = await criarAgente(tenant, tx, criadorId, { extra, tools });
  const ev = await H.avaliar(svc, como(tenant, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'all', ...(providerCode ? { providerCode } : {}) });
  return { code, ev };
}

module.exports = { ...H, criarAgente, svc, agents, golden, CASOS, FONTE, como, cadastrarSeis, semearAprovada, agenteAvaliado, computeGlobalHash };
