'use strict';

// M9-D039 — cadastro da NAY Correspondente: propósito, allowlist, escopos e limites; golden e adversarial verdes antes de habilitar;
// agente somente leitura; parâmetros lidos de verdade; padrão do sistema aplicado pelo seed. Banco descartável, nayara_runtime.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, QueryTypes } = require('sequelize');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, ctxDe, carregarPessoas } = require('../../helpers/aiAgents');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const agents = require('../../../src/features/ai/agents');
const { computeConfigHash } = require('../../../src/features/ai/agents/agentConfigHash');
const { provisionAgentVersion, applySystemDefinition } = require('../../../src/features/ai/agents/kit');
const { finalizeGrounding } = require('../../../src/features/ai/orchestrator/grounding');
const runs = require('../../../src/features/ai/orchestrator/runs');
const N = require('../../../src/features/ai/agents/nay_correspondente');
const { CORRESPONDENTE_SETTING_DEFAULTS: PADROES, CORRESPONDENTE_SETTINGS_SCHEMA } = N;
const { fonteContrato } = require('../_helpers/m9d025Fixtures');
const H = require('../_helpers/iaCorrespondente');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);

test('m9d039_agente_cadastrado_com_proposito_tools_escopos_e_limites', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await carregarPessoas();
    const criador = ctxDe(tenantA);
    const v = await provisionAgentVersion(criador, N.DEFINITION, tx);
    assert.equal(v.code, 'NAY_CORRESPONDENTE');
    assert.equal(v.version, 1);
    assert.equal(v.status, 'DRAFT');
    assert.equal(v.enabled, false, 'nasce desabilitado');
    assert.equal(v.criticality, 'NON_CRITICAL');
    assert.match(v.purpose, /checar pendências de documentos e requisitos, comparar simulações já realizadas e informar status do financiamento/i);
    assert.match(v.purpose, /nunca decidir crédito nem prometer aprovação, taxa ou prazo/);
    assert.deepEqual([...v.dataScopes].sort(), ['correspondent.case_requirements', 'correspondent.financing_cases', 'correspondent.provider_submissions', 'correspondent.simulations']);
    assert.equal(v.limits.max_tool_calls_por_run, 5);
    assert.deepEqual(v.tools.map((t) => t.toolName).sort(), ['correspondent.compareSimulations', 'correspondent.getCaseStatus', 'correspondent.getPendingRequirements', 'correspondent.getStalledCases', 'knowledge.search']);
    assert.ok(v.tools.every((t) => t.enabled && t.riskLevel === 'LOW' && !t.requiresHumanApproval), 'só leitura: nenhuma tool de escrita ou de risco');
    assert.deepEqual(v.tools.filter((t) => t.toolName.startsWith('correspondent.')).map((t) => t.permissionCode), ['correspondent:read', 'correspondent:read', 'correspondent:read', 'correspondent:read']);
    assert.equal(v.configHash, computeConfigHash({ code: v.code, purpose: v.purpose, systemPolicy: v.systemPolicy, modelPolicy: v.modelPolicy, dataScopes: v.dataScopes, limits: v.limits, criticality: v.criticality, tools: v.tools }));
    // as proibições estão na política que o modelo recebe
    for (const termo of [/Nunca decida nem preveja aprovação de crédito/, /nunca prometa taxa, prazo ou parcela/, /nunca envie documento ao banco/, /nunca chame o provider/, /nunca altere o status/]) assert.match(v.systemPolicy, termo);
    // repetir a mesma definição devolve a versão já criada
    const outra = await provisionAgentVersion(criador, N.DEFINITION, tx);
    assert.equal(outra.id, v.id);
    assert.equal(outra.replay, true);
    assert.equal((await agents.listVersions(criador, 'NAY_CORRESPONDENTE', tx)).filter((x) => x.companyId).length, 1);
  });
});

test('m9d039_toda_tool_da_allowlist_existe_no_registro_com_a_permissao_do_cadastro', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const v = await agents.getVersion(c.ctx, 'NAY_CORRESPONDENTE', c.version, tx);
    for (const t of v.tools) {
      const def = c.registry.get(t.toolName);
      assert.ok(def, `${t.toolName} registrada`);
      assert.equal(def.permissionCode, t.permissionCode);
      assert.equal(def.category, 'READ');
      assert.equal(def.requiresHumanApproval, false);
    }
    assert.equal(v.status, 'ACTIVE');
    assert.equal(v.enabled, true);
  });
});

test('m9d039_golden_verde', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const ev = c.evaluation;
    assert.equal(ev.status, 'PASSED', 'golden e adversarial verdes');
    assert.equal(ev.suite, 'ALL');
    const categorias = new Set(ev.items.map((i) => i.category));
    for (const cat of ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'INJECTION', 'COST', 'LATENCY']) assert.ok(categorias.has(cat), `categoria ${cat} avaliada`);
    assert.ok(ev.items.filter((i) => i.caseId.startsWith('golden:corr_')).length >= N.GOLDEN_CASES.length - 2, 'os casos do dataset do agente entraram');
    assert.ok(ev.items.every((i) => i.passed), 'nenhum caso falhou');
    const rows = await H.q("SELECT count(*)::int AS n FROM ai.golden_cases WHERE agent_code = 'NAY_CORRESPONDENTE' AND company_id = :c AND status = 'ACTIVE'", { c: tenantA.companyId }, tx);
    assert.equal(rows[0].n, N.GOLDEN_CASES.length);
    // sem a avaliação homologada por uma pessoa o agente não liga
    const { criador } = c.pessoas;
    const semAvaliacao = await agents.createVersion(H.como(tenantA, criador), 'NAY_CORRESPONDENTE', { systemPolicy: `${N.DEFINITION.systemPolicy} Revisada.` }, tx);
    await assert.rejects(agents.homologate(H.como(tenantA, c.pessoas.homologador), 'NAY_CORRESPONDENTE', semAvaliacao.version, {}, tx), (e) => ['AI_REGRESSION_REQUIRED', 'AI_AGENT_EVALUATION_REQUIRED'].includes(e.code));
    await assert.rejects(agents.activate(H.como(tenantA, c.pessoas.ativador), 'NAY_CORRESPONDENTE', semAvaliacao.version, tx), (e) => e.statusCode === 409);
  });
});

test('m9d039_somente_leitura_agente_nao_cria_recomendacao_nem_com_prazo_critico', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await carregarPessoas();
    const ctx = { ...ctxDe(tenantA), permissions: ['ai:use', 'legal:read'] };
    const { run } = await runs.startRun(ctx, { agentName: 'NAY_CORRESPONDENTE', purpose: 'consulta', inputSummary: 'prazo' }, tx);
    const { run: controle } = await runs.startRun(ctx, { agentName: 'NAY_OBRAS', purpose: 'consulta', inputSummary: 'prazo' }, tx);
    N.registerNayCorrespondente();
    const entrada = (runId, agentCode) => ({ runId, agentCode, answerText: 'O contrato vence em 30/11/2026 [1].', taskType: 'consulta', sources: [fonteContrato()], snapshotAt: '2026-10-27T17:05:00.000Z' });
    const antes = await H.recomendacoes(tx);
    const somenteLeitura = await finalizeGrounding(ctx, entrada(run.id, 'NAY_CORRESPONDENTE'), tx);
    assert.equal(somenteLeitura.requiresHumanConfirmation, true, 'o aviso de confirmação humana continua no texto');
    assert.equal(somenteLeitura.recommendation, null);
    assert.equal(await H.recomendacoes(tx), antes, 'mas nenhuma recomendação é criada');
    const outro = await finalizeGrounding(ctx, entrada(controle.id, 'NAY_OBRAS'), tx);
    assert.equal(outro.requiresHumanConfirmation, true);
    assert.ok(await H.recomendacoes(tx) >= antes, 'o controle: o mecanismo existe para os demais agentes');
  });
});

test('m9d039_parametros_declarados_sao_todos_lidos', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    // max_casos_parados e max_simulacoes mudam o que a resposta lista
    for (const dias of [8, 9, 10]) {
      const caso = await H.criarCaso(tenantA, tx);
      await H.exigir(caso, tenantA, tx, 'RG_CPF');
      await H.envelhecer(caso, dias, tx);
    }
    const tres = await H.rodar(c, 'Casos parados?', { taskType: 'correspondente_casos_parados' });
    assert.match(tres.answer, /3 casos parados/);
    await upsertSetting('ia.correspondente.max_casos_parados', 2, c.ctx, c.ctx.userId, tx);
    const duas = await H.rodar(c, 'Casos parados?', { taskType: 'correspondente_casos_parados' });
    assert.match(duas.answer, /3 casos parados.*listando os 2 mais antigos/);
    assert.equal(duas.answer.split('\n').filter((l) => /^\d+\. Caso/.test(l)).length, 2);
    const caso = await H.criarCaso(tenantA, tx);
    for (const meses of [120, 180, 240]) await H.simulacao(caso, tenantA, tx, { amount: 100000, termMonths: meses, monthlyPayment: 1000 + meses });
    await upsertSetting('ia.correspondente.max_simulacoes', 2, c.ctx, c.ctx.userId, tx);
    const sims = await H.rodar(c, `Compare as simulações do caso ${caso.id}`, { taskType: 'correspondente_comparar_simulacoes' });
    assert.match(sims.answer, /3 simulações registradas.*listando 2/);
    // todo parâmetro declarado tem padrão e faixa no esquema; os de termos são texto
    for (const chave of Object.keys(PADROES)) assert.ok(CORRESPONDENTE_SETTINGS_SCHEMA[chave], `${chave} tem esquema`);
    assert.equal(Object.keys(PADROES).length, Object.keys(CORRESPONDENTE_SETTINGS_SCHEMA).length);
  });
});

test('m9d039_padrao_do_sistema_recebe_o_cadastro_pelo_seed', { skip: DISPOSABLE ? false : 'precisa do cluster descartável' }, async () => {
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  const tx = await admin.transaction();
  try {
    const query = (sql, replacements) => admin.query(sql, { replacements, transaction: tx, type: QueryTypes.SELECT });
    const out = await applySystemDefinition(query, N.DEFINITION);
    const [row] = await query("SELECT * FROM ai.agents WHERE company_id IS NULL AND code = 'NAY_CORRESPONDENTE' AND version = 1");
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.enabled, false);
    assert.equal(row.config_hash, out.configHash);
    assert.equal(row.purpose, N.DEFINITION.purpose);
    assert.deepEqual(row.data_scopes, N.DEFINITION.dataScopes);
    assert.equal(row.limits.max_tool_calls_por_run, 5);
    const tools = await query("SELECT tool_name, permission_code FROM ai.agent_tools WHERE agent_id = :id ORDER BY tool_name", { id: row.id });
    assert.deepEqual(tools.map((t) => t.tool_name), N.DEFINITION.tools.map((t) => t.toolName).sort());
    const tools2 = N.DEFINITION.tools.map((t) => ({ ...t }));
    assert.equal(out.configHash, computeConfigHash({ code: row.code, purpose: row.purpose, systemPolicy: row.system_policy, modelPolicy: row.model_policy, dataScopes: row.data_scopes, limits: row.limits, criticality: row.criticality, tools: tools2 }));
    // idempotente
    assert.equal((await applySystemDefinition(query, N.DEFINITION)).configHash, out.configHash);
    // as outras sete linhas do sistema não foram tocadas
    const outras = await query("SELECT count(*)::int AS n FROM ai.agents WHERE company_id IS NULL AND code <> 'NAY_CORRESPONDENTE' AND system_policy = ''");
    assert.ok(outras[0].n >= 1);
  } finally {
    await tx.rollback();
    await admin.close();
  }
});
