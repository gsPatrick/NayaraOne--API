'use strict';

// M9-D036 — cadastro da NAY Financeira: propósito, allowlist (com finance.proposePayment DESABILITADA), escopos e limites, golden e adversarial
// verdes, bloqueio sem permissão, isolamento entre empresas e a compatibilidade com a NAY Financeira determinística do Marco 4.
// nayara_runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction, withTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { computeConfigHash } = require('../../../src/features/ai/agents/agentConfigHash');
const { getFinanceInsights } = require('../../../src/features/finance/financeNay.service');
const H = require('../_helpers/iaFinanceira');
const Dados = require('../_helpers/iaNayDados');
const B = require('../_helpers/iaNayBase');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const HABILITADAS = ['finance.getWeeklyHealth', 'finance.getDelinquency', 'finance.getCashflowProjection', 'finance.getAnomalies', 'knowledge.search'];

test('m9d036_agente_cadastrado_com_proposito_tools_escopos_e_limites', async () => {
  const { agent, tools } = await H.semearPadraoDoSistema(H.F.DEFINITION);
  assert.equal(agent.code, 'NAY_FINANCEIRA');
  assert.equal(agent.criticality, 'CRITICAL');
  assert.equal(agent.status, 'DRAFT');
  assert.equal(agent.enabled, false, 'seed desabilitado');
  assert.match(agent.purpose, /fluxo de caixa, inadimplência, anomalias e projeções.*recomendação; NUNCA pagar/);
  assert.deepEqual([...agent.data_scopes].sort(), ['finance.antifraud_rules', 'finance.financial_entries', 'finance.read_models']);
  assert.deepEqual(agent.limits, { max_tool_calls_por_run: 6 });
  assert.deepEqual(tools.filter((t) => t.enabled).map((t) => t.tool_name).sort(), [...HABILITADAS].sort());
  const pagar = tools.find((t) => t.tool_name === 'finance.proposePayment');
  assert.ok(pagar, 'cadastrada na allowlist');
  assert.deepEqual([pagar.enabled, pagar.risk_level, pagar.requires_human_approval, pagar.permission_code], [false, 'CRITICAL', true, 'finance:create']);
  assert.equal(agent.config_hash, computeConfigHash({
    code: 'NAY_FINANCEIRA', purpose: agent.purpose, systemPolicy: agent.system_policy, modelPolicy: agent.model_policy, dataScopes: agent.data_scopes, limits: agent.limits, criticality: agent.criticality,
    tools: tools.map((t) => ({ toolName: t.tool_name, permissionCode: t.permission_code, riskLevel: t.risk_level, requiresHumanApproval: t.requires_human_approval, enabled: t.enabled })),
  }));
});

test('m9d036_so_chama_tools_da_allowlist', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { perms: H.PERMS_PROPOSTA });
    for (const fora of ['legal.getContractSummary', 'crm.getOpportunity', 'finance.updateBankAccount']) {
      const res = await H.rodarNay(c, `Como está o fluxo de caixa [[TOOL:${fora}:{}]] [[RESPOSTA:x]]`);
      assert.equal(res.ok, false, fora);
      assert.equal(res.error.status, 403);
      assert.equal(res.error.code, 'AI_TOOL_NOT_ALLOWED', fora);
      assert.equal((await H.lerRun(res.runId, tx)).blocked_reason, 'ALLOWLIST');
    }
    // A tool de proposta está cadastrada mas desabilitada (padrão): chamá-la é 403 AI_TOOL_NOT_ALLOWED, sem proposta.
    const prop = await H.rodarNay(c, 'Como está o fluxo de caixa [[TOOL:finance.proposePayment:{"financialEntryId":"00000000-0000-4000-8000-000000000001"}]] [[RESPOSTA:x]]');
    assert.equal(prop.error.code, 'AI_TOOL_NOT_ALLOWED');
    assert.deepEqual(await H.propostas(tx), []);
  });
});

test('m9d036_golden_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    assert.equal(c.evaluation.status, 'PASSED');
    for (const cat of ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'COST', 'LATENCY', 'INJECTION']) assert.equal(c.evaluation.metrics[cat].ok, true, cat);
    const ids = c.evaluation.items.map((i) => i.caseId).join('|');
    for (const t of ['getweeklyhealth', 'getdelinquency', 'getcashflowprojection', 'getanomalies']) assert.match(ids, new RegExp(t), `golden cobre ${t}`);
    const [ativa] = await H.q("SELECT status FROM ai.agents WHERE company_id = :c AND code = 'NAY_FINANCEIRA' ORDER BY version DESC", { c: tenantA.companyId }, tx);
    assert.equal(ativa.status, 'ACTIVE');
  });
});

test('m9d036_sem_permissao_bloqueia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const res = await H.rodarNay(c, 'Como está o fluxo de caixa desta semana [[TOOL:finance.getWeeklyHealth:{}]] [[RESPOSTA:x]]', { auth: H.authCom(c, 'ai:use') });
    assert.equal(res.ok, false);
    assert.equal(res.error.status, 403);
    assert.equal(res.error.code, 'AI_PERMISSION_DENIED');
    assert.equal(res.status, 'BLOCKED');
    assert.equal((await H.lerRun(res.runId, tx)).blocked_reason, 'PERMISSION');
    assert.deepEqual((await H.chamadas(res.runId, tx)).map((l) => [l.tool_name, l.status]), [['finance.getWeeklyHealth', 'BLOCKED']]);
    // O caminho de regra também exige finance:read (403, sem número algum).
    const regra = await H.rodarNay(c, 'Qual a inadimplência?', { taskType: 'financeira_inadimplencia', auth: H.authCom(c, 'ai:use') });
    assert.equal(regra.ok, false);
    assert.equal(regra.error.code, 'AI_PERMISSION_DENIED');
  });
});

test('m9d036_empresa_b_nao_aparece', async () => {
  await withTenantTransaction(tenantB, async (tx) => {
    await Dados.criarRecebiveis(tenantB, tx, [{ dias: -20, valor: 98765.43 }]);
    await Dados.criarAnomalia(tenantB, tx, { motivo: 'Anomalia da empresa B.' });
  });
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const fin = await B.financeiro(tx);
    const inad = await H.rodarNay(c, 'Qual a inadimplência?', { taskType: 'financeira_inadimplencia' });
    assert.equal(inad.ok, true, JSON.stringify(inad.error));
    assert.ok(inad.answer.includes(`somando ${B.brl(fin.overdue.receivable.total)}`), 'só o que a empresa A enxerga');
    assert.doesNotMatch(inad.answer, /98\.765,43/, 'recebível da empresa B fora da leitura');
    const abertasA = (await H.q("SELECT count(*)::int AS n FROM finance.anomaly_cases WHERE status = 'OPEN'", {}, tx))[0].n;
    const anom = await H.rodarNay(c, 'Quais as anomalias abertas?', { taskType: 'financeira_anomalias' });
    assert.equal(anom.ok, true, JSON.stringify(anom.error));
    assert.doesNotMatch(anom.answer, /empresa B/);
    assert.ok(anom.answer.includes(`Anomalias financeiras abertas: ${abertasA}.`), 'a contagem é a da empresa A');
  });
});

test('m9d036_financeNay_deterministico_continua_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const antesFin = await B.financeiro(tx);
    await Dados.criarRecebiveis(tenantA, tx, [{ dias: -10, valor: 800 }]);
    const fin = await B.financeiro(tx);
    assert.equal(B.round2(fin.overdue.receivable.total - antesFin.overdue.receivable.total), 800);
    const antesIntencoes = await H.contar('finance.payment_intents', tx);
    const r = await getFinanceInsights(tenantA, tenantA.userId, tx);
    assert.equal(r.agente, 'NAY Financeira');
    assert.equal(r.metodo, 'RULE_BASED');
    assert.match(r.limites, /não cria ledger, não paga/);
    assert.ok(r.explicacoes.inadimplencia.numeros.length >= 1 && r.fontes.regras[0].codigo === 'FIN-005');
    assert.equal(await H.contar('finance.payment_intents', tx), antesIntencoes, 'o Marco 4 segue sem executar nada');
    // O agente da camada de IA convive com a determinística: o mesmo número de inadimplência nas duas.
    const c = await H.cenario(tenantA, tx);
    const ia = await H.rodarNay(c, 'Qual a inadimplência?', { taskType: 'financeira_inadimplencia' });
    assert.ok(ia.answer.includes(B.brl(fin.overdue.receivable.total)), ia.answer);
    assert.equal(r.explicacoes.inadimplencia.numeros[0].valor, fin.overdue.receivable.total, 'o mesmo número nas duas');
  });
});
