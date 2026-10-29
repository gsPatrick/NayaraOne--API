'use strict';

// M9-D038 — NAY Jurídica: cadastro (propósito, tools, escopos, limites, criticidade), allowlist com a única escrita em proposta,
// permissão, golden verde, isolamento entre empresas e o serviço determinístico preservado. Banco descartável, sandbox.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction, withTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { computeConfigHash } = require('../../../src/features/ai/agents/agentConfigHash');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const policy = require('../../../src/features/ai/agents/nay_juridica/juridica.policy');
const { AGENTE } = require('../../../migrations/_helpers/aiAgentJuridica');
const nay = require('../../../src/features/legal/legalNay.service');
const H = require('../_helpers/m9d037Agente');
const J = require('../_helpers/m9d038Juridico');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PERMS = ['ai:use', 'legal:read', 'legal:create'];
const TOOLS = ['legal.getContractSummary', 'legal.compareVersions', 'legal.getRequirementsChecklist', 'legal.getDeadlines', 'knowledge.search', 'legal.draftContract'];

test('m9d038_agente_cadastrado_com_proposito_tools_escopos_e_limites', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [row] = await H.q("SELECT * FROM ai.agents WHERE company_id IS NULL AND code = 'NAY_JURIDICA' AND version = 1", {}, tx);
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.enabled, false);
    assert.equal(row.criticality, 'CRITICAL');
    assert.equal(row.purpose, policy.PURPOSE);
    assert.equal(row.system_policy, policy.SYSTEM_POLICY);
    assert.deepEqual(row.data_scopes, ['legal.contracts', 'legal.contract_versions', 'legal.requirements', 'legal.addenda', 'knowledge.homologated']);
    assert.deepEqual(row.limits, { max_tool_calls_por_run: 6 });
    const tools = await H.q('SELECT tool_name, permission_code, risk_level, requires_human_approval, enabled FROM ai.agent_tools WHERE agent_id = :id ORDER BY tool_name', { id: row.id }, tx);
    assert.deepEqual(tools.map((t) => t.tool_name), [...TOOLS].sort());
    const escrita = tools.filter((t) => t.risk_level !== 'LOW');
    assert.deepEqual(escrita.map((t) => [t.tool_name, t.risk_level, t.requires_human_approval, t.permission_code]), [['legal.draftContract', 'HIGH', true, 'legal:create']], 'a única escrita é a proposta da minuta');
    const doCodigo = computeConfigHash({ code: policy.CODE, purpose: policy.PURPOSE, systemPolicy: policy.SYSTEM_POLICY, modelPolicy: policy.MODEL_POLICY, dataScopes: [...policy.DATA_SCOPES], limits: { ...policy.LIMITS }, criticality: policy.CRITICALITY, tools: policy.TOOLS });
    assert.equal(doCodigo, row.config_hash, 'paridade entre a migration e a política de aplicação');
    assert.deepEqual(AGENTE.tools.map((t) => t.toolName).sort(), [...TOOLS].sort());
  });
});

test('m9d038_so_chama_tools_da_allowlist', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: [...PERMS, 'finance:read', 'crm:tasks:create'] });
    assert.deepEqual(c.agent.tools.map((t) => t.toolName).sort(), [...TOOLS].sort());
    for (const fora of ['finance.getWeeklyHealth', 'crm.createFollowUpTask', 'construction.getBudgetVsActual']) {
      const res = await H.perguntar(c, `Contrato: ${fora} [[TOOL:${fora}:{}]]`);
      assert.equal(res.ok, false, fora);
      assert.equal(res.error.status, 403, fora);
      assert.equal(res.error.code, 'AI_TOOL_NOT_ALLOWED', fora);
    }
  });
});

test('m9d038_golden_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const svc = new AiEvaluationService();
    const { evaluation } = await svc.request(c.ctx, { agentCode: 'NAY_JURIDICA', suite: 'all', agentVersion: c.agent.version }, tx);
    await svc.processQueued(c.ctx, tx, { evaluationId: evaluation.id });
    const feita = await svc.get(c.ctx, evaluation.id, tx);
    assert.equal(feita.status, 'PASSED', JSON.stringify(feita.metrics));
    const chaves = feita.items.map((i) => JSON.stringify(i)).join('|');
    for (const caso of ['juridica_grounding_checklist_com_fonte', 'juridica_hallucination_clausula_sem_fonte', 'juridica_tool_comparar_versoes', 'juridica_permissao_minuta_sem_legal_create']) assert.match(chaves, new RegExp(caso), `caso ${caso} entrou na avaliação`);
    assert.ok(feita.items.every((i) => i.passed), 'nenhum caso reprovado');
  });
});

test('m9d038_sem_permissao_bloqueia', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const s = await J.cenarioJuridico(tenantA, tx);
    const como = (...permissions) => ({ auth: { ...c.auth, permissions } });
    const viaTool = await H.perguntar(c, `Checklist [[TOOL:legal.getRequirementsChecklist:{"contractId":"${s.contract.id}"}]] [[RESPOSTA:ok]]`, como('ai:use'));
    assert.equal(viaTool.ok, false);
    assert.equal(viaTool.error.status, 403);
    assert.equal(viaTool.error.code, 'AI_PERMISSION_DENIED');
    assert.equal(viaTool.error.message, 'Você não tem permissão para consultar estes dados.');
    // A minuta (legal:create) exige a permissão própria: só com legal:read o rascunho é recusado.
    const minuta = await H.perguntar(c, '[[TOOL:legal.draftContract:{"contractType":"LEASE"}]]', como('ai:use', 'legal:read'));
    assert.equal(minuta.ok, false);
    assert.equal(minuta.error.code, 'AI_PERMISSION_DENIED');
    // A validade só vira checklist para quem pode ler o jurídico.
    const validade = await H.perguntar(c, 'O contrato já está válido?', { ...como('ai:use'), subject: { type: 'legalContract', id: s.contract.id } });
    assert.equal(validade.ok, false);
    assert.equal(validade.error.code, 'AI_PERMISSION_DENIED');
  });
});

test('m9d038_empresa_b_nao_aparece', async () => {
  const contratoA = await withTenantTransaction(tenantA, async (tx) => (await J.cenarioJuridico(tenantA, tx)).contract);
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const b = await H.ativarAgente(tenantB, tx, 'NAY_JURIDICA', { perms: PERMS });
    for (const [tool, args] of [['legal.getRequirementsChecklist', ''], ['legal.getDeadlines', ''], ['legal.compareVersions', ',"fromVersion":1,"toVersion":2']]) {
      const res = await H.perguntar(b, `Consulta [[TOOL:${tool}:{"contractId":"${contratoA.id}"${args}}]] [[RESPOSTA:ok]]`);
      assert.equal(res.ok, false, tool);
      assert.equal(res.error.status, 404, tool);
      assert.equal(res.error.code, 'AI_CROSS_COMPANY_BLOCKED', tool);
    }
    const validade = await H.perguntar(b, 'O contrato já está válido?', { subject: { type: 'legalContract', id: contratoA.id } });
    assert.equal(validade.ok, false, 'a empresa B não vê o contrato da A nem pela resposta de validade');
  });
});

test('m9d038_legalNay_deterministico_continua_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const s = await J.cenarioJuridico(tenantA, tx);
    const ctx = { groupId: tenantA.groupId, companyId: tenantA.companyId };
    const resumo = await nay.summarizeContract(ctx, s.contract.id, tenantA.userId, tx);
    assert.equal(nay.AGENT_NAME, 'NAY_JURIDICA');
    assert.equal(resumo.metodo, 'RULE_BASED');
    assert.equal(resumo.totalVersoes, 2);
    const cmp = await nay.compareContractVersions(ctx, s.contract.id, 1, 2, tenantA.userId, tx);
    // A tool da camada de IA enxerga as mesmas diferenças do serviço preservado.
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    const res = await H.perguntar(c, `Compare [[TOOL:legal.compareVersions:{"contractId":"${s.contract.id}","fromVersion":1,"toVersion":2}]] [[RESPOSTA:ok [1]]]`);
    const [chamada] = await H.chamadas(res.runId, tx);
    const saida = JSON.stringify(chamada);
    for (const linha of [...cmp.linhasRemovidas, ...cmp.linhasIncluidas]) assert.ok(saida.includes(linha), `a tool traz a linha "${linha}"`);
  });
});
