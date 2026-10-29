'use strict';

// M9-D037 — NAY Obras: cadastro (propósito, tools, escopos, limites), allowlist, permissão, golden verde e isolamento entre empresas.
// Banco descartável (nayara_runtime, RLS real). Roda com o provider sandbox.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction, withTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { computeConfigHash } = require('../../../src/features/ai/agents/agentConfigHash');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const policy = require('../../../src/features/ai/agents/nay_obras/obras.policy');
const { AGENTE } = require('../../../migrations/_helpers/aiAgentObras');
const H = require('../_helpers/m9d037Agente');
const O = require('../_helpers/m9d037Obras');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PERMS = ['ai:use', 'construction:read'];
const TOOLS = ['construction.getProjectProgress', 'construction.getBudgetVsActual', 'construction.getDailyReports', 'construction.getQualityNonConformities', 'construction.getWarrantyCases', 'knowledge.search'];

test('m9d037_agente_cadastrado_com_proposito_tools_escopos_e_limites', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [row] = await H.q("SELECT * FROM ai.agents WHERE company_id IS NULL AND code = 'NAY_OBRAS' AND version = 1", {}, tx);
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.enabled, false);
    assert.equal(row.criticality, 'NON_CRITICAL');
    assert.equal(row.purpose, policy.PURPOSE);
    assert.match(row.purpose, /progresso.*custos.*diário.*qualidade.*pós-obra/s);
    assert.equal(row.system_policy, policy.SYSTEM_POLICY);
    assert.deepEqual(row.data_scopes, ['construction.projects', 'construction.daily_reports', 'construction.budget_lines', 'construction.maintenance_cases']);
    assert.deepEqual(row.limits, { max_tool_calls_por_run: 6 });
    const tools = await H.q('SELECT tool_name, permission_code, risk_level, requires_human_approval, enabled FROM ai.agent_tools WHERE agent_id = :id ORDER BY tool_name', { id: row.id }, tx);
    assert.deepEqual(tools.map((t) => t.tool_name), [...TOOLS].sort());
    assert.ok(tools.every((t) => t.risk_level === 'LOW' && t.requires_human_approval === false && t.enabled === true), 'só leitura: nenhuma tool de escrita');
    assert.deepEqual(row.permissions, ['ai:use', 'construction:read'], 'permissões do agente = as das tools habilitadas');
    // A política de código e a migration são a mesma configuração (mesmo hash).
    const hash = computeConfigHash({ code: 'NAY_OBRAS', purpose: row.purpose, systemPolicy: row.system_policy, modelPolicy: row.model_policy, dataScopes: row.data_scopes, limits: row.limits, criticality: row.criticality,
      tools: tools.map((t) => ({ toolName: t.tool_name, permissionCode: t.permission_code, riskLevel: t.risk_level, requiresHumanApproval: t.requires_human_approval, enabled: t.enabled })) });
    assert.equal(row.config_hash, hash);
    const doCodigo = computeConfigHash({ code: policy.CODE, purpose: policy.PURPOSE, systemPolicy: policy.SYSTEM_POLICY, modelPolicy: policy.MODEL_POLICY, dataScopes: [...policy.DATA_SCOPES], limits: { ...policy.LIMITS }, criticality: policy.CRITICALITY, tools: policy.TOOLS });
    assert.equal(doCodigo, row.config_hash, 'paridade entre a migration e a política de aplicação');
    assert.deepEqual(AGENTE.tools.map((t) => t.toolName).sort(), [...TOOLS].sort());
  });
});

test('m9d037_so_chama_tools_da_allowlist', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: [...PERMS, 'finance:read', 'crm:tasks:create', 'legal:read'] });
    assert.deepEqual(c.agent.tools.map((t) => t.toolName).sort(), [...TOOLS].sort());
    // Tools de outras áreas (inclusive de escrita) não estão na allowlist: 403 AI_TOOL_NOT_ALLOWED, mesmo com a permissão do usuário.
    for (const fora of ['finance.getWeeklyHealth', 'legal.draftContract', 'crm.createFollowUpTask']) {
      const res = await H.perguntar(c, `Obras: preciso de ${fora} [[TOOL:${fora}:{}]]`);
      assert.equal(res.ok, false, fora);
      assert.equal(res.error.status, 403, fora);
      assert.equal(res.error.code, 'AI_TOOL_NOT_ALLOWED', fora);
      assert.equal(res.error.message, 'Este agente não pode usar esta ferramenta.');
    }
    assert.equal(await H.contar("SELECT count(*)::int AS n FROM ai.tool_calls WHERE status = 'SUCCEEDED' AND tool_name IN ('finance.getWeeklyHealth','legal.draftContract','crm.createFollowUpTask')", {}, tx), 0);
  });
});

test('m9d037_golden_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    const svc = new AiEvaluationService();
    const { evaluation } = await svc.request(c.ctx, { agentCode: 'NAY_OBRAS', suite: 'all', agentVersion: c.agent.version }, tx);
    await svc.processQueued(c.ctx, tx, { evaluationId: evaluation.id });
    const feita = await svc.get(c.ctx, evaluation.id, tx);
    assert.equal(feita.status, 'PASSED', JSON.stringify(feita.metrics));
    const chaves = feita.items.map((i) => JSON.stringify(i)).join('|');
    for (const caso of ['obras_grounding_custos_com_fonte', 'obras_hallucination_atraso_sem_fonte', 'obras_tool_custos', 'obras_permissao_sem_construction_read']) assert.match(chaves, new RegExp(caso), `caso ${caso} entrou na avaliação`);
    assert.ok(feita.items.every((i) => i.passed), 'nenhum caso reprovado');
  });
});

test('m9d037_sem_permissao_bloqueia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const sem = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: ['ai:use'] });
    const obra = await O.criarObra(tenantA, tx, { atrasoDias: 3 });
    const viaTool = await H.perguntar(sem, `Custos da obra [[TOOL:construction.getBudgetVsActual:{"projectId":"${obra.id}"}]] [[RESPOSTA:ok]]`);
    assert.equal(viaTool.ok, false);
    assert.equal(viaTool.error.status, 403);
    assert.equal(viaTool.error.code, 'AI_PERMISSION_DENIED');
    const viaRegra = await H.perguntar(sem, 'Quais obras estão atrasadas e por quê?', { taskType: 'listar_obras_atrasadas' });
    assert.equal(viaRegra.ok, false);
    assert.equal(viaRegra.error.status, 403);
    assert.equal(viaRegra.error.code, 'AI_PERMISSION_DENIED');
    assert.equal(viaRegra.error.message, 'Você não tem permissão para consultar estes dados.');
  });
});

test('m9d037_empresa_b_nao_aparece', async () => {
  const obraA = await withTenantTransaction(tenantA, (tx) => O.criarObra(tenantA, tx, { name: 'QA-M9 Obra da empresa A', atrasoDias: 12 }));
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const b = await H.ativarAgente(tenantB, tx, 'NAY_OBRAS', { perms: PERMS });
    const lista = await H.perguntar(b, 'Quais obras estão atrasadas?', { taskType: 'listar_obras_atrasadas' });
    assert.equal(lista.ok, true, JSON.stringify(lista.error));
    assert.doesNotMatch(lista.answer, /empresa A/);
    const tool = await H.perguntar(b, `Custos [[TOOL:construction.getBudgetVsActual:{"projectId":"${obraA.id}"}]] [[RESPOSTA:ok]]`);
    assert.equal(tool.ok, false);
    assert.equal(tool.error.status, 404);
    assert.equal(tool.error.code, 'AI_CROSS_COMPANY_BLOCKED');
  });
});

test('m9d037_nayObras_deterministico_continua_verde', async () => {
  const { summarizeProject } = require('../../../src/features/construction/nayObras.service');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const obra = await O.criarObra(tenantA, tx, { atrasoDias: 10, orcado: '100000.00', realizado: '112500.00' });
    const resumo = await summarizeProject(obra.id, tx);
    assert.equal(resumo.component, 'NAY Obras');
    assert.deepEqual(resumo.decisionsMade, []);
    const c = await H.ativarAgente(tenantA, tx, 'NAY_OBRAS', { perms: PERMS });
    const res = await H.perguntar(c, 'Quais obras estão atrasadas e por quê?', { taskType: 'listar_obras_atrasadas' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    // O resolvedor RULE expõe o mesmo dado do serviço determinístico preservado.
    assert.match(res.answer, new RegExp(`${resumo.summary.scheduleDelayDays} dias`));
  });
});
