'use strict';

// M9-D035 — cadastro da NAY Diretoria: propósito, allowlist exata, escopos e limites (padrão do sistema e versão da empresa), golden e
// adversarial verdes antes de habilitar, bloqueio sem permissão e isolamento entre empresas. nayara_runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { computeConfigHash } = require('../../../src/features/ai/agents/agentConfigHash');
const H = require('../_helpers/iaDiretoria');
const Dados = require('../_helpers/iaNayDados');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const TOOLS_DO_LIVRO = ['finance.getWeeklyHealth', 'crm.getPipelineSummary', 'construction.getPortfolioProgress', 'legal.getExpiringContracts', 'correspondent.getStalledCases', 'inventory.getStockRisks', 'knowledge.search', 'memory.recall'];

test('m9d035_agente_cadastrado_com_proposito_tools_escopos_e_limites', async () => {
  const { agent, tools } = await H.semearPadraoDoSistema(H.D.DEFINITION);
  assert.equal(agent.code, 'NAY_DIRETORIA');
  assert.equal(agent.status, 'DRAFT');
  assert.equal(agent.enabled, false, 'seed desabilitado');
  assert.equal(agent.criticality, 'NON_CRITICAL');
  assert.match(agent.purpose, /saúde da empresa.*riscos e prioridades.*explicar indicadores.*não executa nada/);
  assert.deepEqual([...agent.data_scopes].sort(), ['construction.summary', 'correspondent.summary', 'crm.summary', 'finance.summary', 'inventory.summary', 'legal.summary']);
  assert.deepEqual(agent.limits, { max_tool_calls_por_run: 8 });
  assert.deepEqual(tools.map((t) => t.tool_name).sort(), [...TOOLS_DO_LIVRO].sort());
  assert.ok(tools.every((t) => ['LOW', 'MEDIUM'].includes(t.risk_level) && t.requires_human_approval === false && t.enabled === true), 'todas de leitura');
  assert.equal(agent.config_hash, computeConfigHash({
    code: 'NAY_DIRETORIA', purpose: agent.purpose, systemPolicy: agent.system_policy, modelPolicy: agent.model_policy, dataScopes: agent.data_scopes, limits: agent.limits, criticality: agent.criticality,
    tools: tools.map((t) => ({ toolName: t.tool_name, permissionCode: t.permission_code, riskLevel: t.risk_level, requiresHumanApproval: t.requires_human_approval, enabled: t.enabled })),
  }));
  const again = await H.semearPadraoDoSistema(H.D.DEFINITION);
  assert.equal(again.agent.config_hash, agent.config_hash, 'repetir o seed dá o mesmo resultado');
});

test('m9d035_so_chama_tools_da_allowlist', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const row = (await H.q("SELECT id FROM ai.agents WHERE company_id = :c AND code = 'NAY_DIRETORIA' AND status = 'ACTIVE'", { c: tenantA.companyId }, tx))[0];
    const lista = await H.q('SELECT tool_name FROM ai.agent_tools WHERE agent_id = :id ORDER BY tool_name', { id: row.id }, tx);
    assert.deepEqual(lista.map((t) => t.tool_name), [...TOOLS_DO_LIVRO].sort(), 'allowlist exata');
    // Tool que existe no registro mas não está na allowlist: 403 AI_TOOL_NOT_ALLOWED, run BLOCKED.
    for (const fora of ['finance.getDelinquency', 'finance.proposePayment', 'crm.getOpportunity']) {
      const res = await H.rodarNay(c, `Como está o resumo da empresa [[TOOL:${fora}:{}]] [[RESPOSTA:x]]`);
      assert.equal(res.ok, false, fora);
      assert.equal(res.error.status, 403);
      assert.equal(res.error.code, 'AI_TOOL_NOT_ALLOWED', fora);
      assert.equal((await H.lerRun(res.runId, tx)).blocked_reason, 'ALLOWLIST');
      assert.equal((await H.chamadas(res.runId, tx))[0].status, 'BLOCKED');
    }
  });
});

test('m9d035_golden_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx); // o cenário só segue se a avaliação ALL (golden + adversarial) passou e foi homologada
    assert.equal(c.evaluation.status, 'PASSED');
    for (const cat of ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'COST', 'LATENCY']) assert.equal(c.evaluation.metrics[cat].ok, true, cat);
    const itens = c.evaluation.items.map((i) => i.caseId);
    for (const t of TOOLS_DO_LIVRO.filter((n) => !['knowledge.search', 'memory.recall'].includes(n))) assert.ok(itens.some((id) => id.includes(t.replace(/[^a-zA-Z]+/g, '_').toLowerCase())), `golden cobre ${t}`);
    const hom = (await H.q("SELECT status FROM ai.agents WHERE company_id = :c AND code = 'NAY_DIRETORIA' ORDER BY version DESC", { c: tenantA.companyId }, tx))[0];
    assert.equal(hom.status, 'ACTIVE');
  });
});

test('m9d035_sem_permissao_bloqueia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const auth = H.authCom(c, 'ai:use'); // sem nenhuma permissão de área
    const res = await H.rodarNay(c, 'Como está o resumo do financeiro da empresa [[TOOL:finance.getWeeklyHealth:{}]] [[RESPOSTA:x]]', { auth });
    assert.equal(res.ok, false);
    assert.equal(res.error.status, 403);
    assert.equal(res.error.code, 'AI_PERMISSION_DENIED');
    assert.equal(res.status, 'BLOCKED');
    const run = await H.lerRun(res.runId, tx);
    assert.equal(run.blocked_reason, 'PERMISSION');
    const [l] = await H.chamadas(res.runId, tx);
    assert.deepEqual([l.tool_name, l.status], ['finance.getWeeklyHealth', 'BLOCKED']);
    assert.ok(Number((await H.q("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'ai.tool_call.blocked'", {}, tx))[0].n) >= 1);
  });
});

test('m9d035_empresa_b_nao_aparece', async () => {
  const { withTenantTransaction } = require('../../testHelpers');
  const B = require('../_helpers/iaNayBase');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const antes = await B.bandas(tx);
    // Dados COMMITADOS na empresa B depois da referência: se vazassem, a faixa da A cresceria por eles.
    await withTenantTransaction(tenantB, async (txB) => { await Dados.criarContratos(tenantB, txB, [{ dias: 5, valor: 999 }, { dias: 6, valor: 999 }]); });
    await Dados.criarContratos(tenantA, tx, [{ dias: 10, valor: 100 }]);
    const depois = await B.bandas(tx);
    assert.equal(depois.bands[0].count - antes.bands[0].count, 1, 'só o contrato da empresa A');
    const res = await H.rodarNay(c, 'Quantos contratos vencem em breve? [[TOOL:legal.getExpiringContracts:{}]] [[RESPOSTA:Há {{num:contratos_f1_qtd}} contratos vencendo em até {{num:contratos_f1_dias}} [1].]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.ok(res.answer.includes(`Há ${depois.bands[0].count} contratos vencendo em até 30 dias`), res.answer);
    assert.equal(depois.bands[0].count, antes.bands[0].count + 1);
  });
});
