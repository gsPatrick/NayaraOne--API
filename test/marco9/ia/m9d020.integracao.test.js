'use strict';

// M9-D020 — o orquestrador usando o que as demais demandas entregaram: carimbo e limites do agente (D004), taxa por pessoa em contador
// de banco, limites de argumento da empresa (D018), varredura da saída (D021), replay e andamento da tool (D006) e a chamada da tool
// com o contexto restrito (D017). Repete os testes 7, 8 e 12 da D004 pelo fluxo do orquestrador, com o provider sandbox.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { createToolCallRecorder } = require('../../../src/features/ai/tools/toolCallRecorder');
const { defValida } = require('../_helpers/aiToolDefs');
const { definirParametro } = require('../_helpers/iaOrcamento');
const { toolContadora } = require('../_helpers/iaOrqTools');
const H = require('../_helpers/iaOrquestrador');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

test('m9d004_run_grava_agent_version_pelo_orquestrador', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const res = await H.rodar(c, `Resuma ${H.pedirOportunidade(c)} [[RESPOSTA:Ok [1].]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const run = await H.lerRun(res.runId, tx);
    const agente = (await H.q('SELECT id, version FROM ai.agents WHERE company_id = :c AND code = :code', { c: tenantA.companyId, code: c.code }, tx))[0];
    assert.equal(run.agent_id, agente.id);
    assert.equal(run.agent_version, agente.version);
    assert.equal(run.agent_name, c.code);
  });
});

test('m9d004_limite_tool_calls_bloqueia_run_pelo_orquestrador', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { def, execucoes } = toolContadora();
    const c = await H.cenario(tenantA, tx, { tools: ['teste.lerAlgo'], extraDefs: [def] });
    const seis = Array.from({ length: 6 }, () => '[[TOOL:teste.lerAlgo:{}]]').join(' ');
    const res = H.falhou(await H.rodar(c, `Leia tudo ${seis} [[RESPOSTA:ok]]`), 422, 'AI_TOOL_LIMIT_EXCEEDED', 'BLOCKED');
    assert.equal(execucoes.length, 5, 'o padrão ia.agente.max_tool_calls_por_run é 5');
    assert.equal((await H.lerRun(res.runId, tx)).blocked_reason, 'TOOL_LIMIT');
  });
});

test('m9d004_estouro_de_tool_e_token_devolve_422_com_codigo_pelo_orquestrador', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { def } = toolContadora();
    const c = await H.cenario(tenantA, tx, { tools: ['teste.lerAlgo'], extraDefs: [def], agentOver: { limits: { max_tool_calls_por_run: 1, max_tokens_run: 100 } } });
    const tools = H.falhou(await H.rodar(c, 'Leia [[TOOL:teste.lerAlgo:{}]] [[TOOL:teste.lerAlgo:{}]] [[RESPOSTA:ok]]'), 422, 'AI_TOOL_LIMIT_EXCEEDED', 'BLOCKED');
    assert.match(tools.error.message, /A NAY atingiu o limite de ferramentas por consulta\./);
    const longo = `${'dado de contexto '.repeat(40)}[[TOOL:teste.lerAlgo:{}]] [[RESPOSTA:ok]]`;
    const tokens = H.falhou(await H.rodar(c, longo), 422, 'AI_TOKEN_LIMIT_EXCEEDED', 'FAILED');
    assert.match(tokens.error.message, /A NAY atingiu o limite de processamento desta consulta\./);
  });
});

test('m9d020_taxa_por_pessoa_em_contador_de_banco', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: { limits: { max_runs_por_minuto_usuario: 2 } } });
    for (let i = 0; i < 2; i += 1) assert.equal((await H.rodar(c, `Classifique ${i} [[RESPOSTA:ok]]`, { taskType: 'classificar' })).ok, true);
    const err = await H.rodar(c, 'Classifique 3 [[RESPOSTA:ok]]', { taskType: 'classificar' }).then(() => null, (e) => e);
    assert.equal(err.statusCode, 429);
    assert.equal(err.code, 'AI_RATE_LIMITED');
    assert.equal((await H.q("SELECT count(*)::int AS n FROM ai.ai_runs WHERE agent_name = :c", { c: c.code }, tx))[0].n, 2, 'a terceira nem cria run');
  });
});

test('m9d020_argumentos_validados_com_os_limites_da_empresa_na_transacao_do_tenant', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const def = defValida({
      name: 'teste.buscar', permissionCode: 'crm:opportunities:read', inputSchema: { type: 'object', properties: { termo: { type: 'string' } }, required: ['termo'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { id: { type: 'string' }, nome: { type: 'string' } }, required: ['id'], additionalProperties: false },
    });
    const c = await H.cenario(tenantA, tx, { tools: ['teste.buscar'], extraDefs: [def] });
    const pedido = (t) => `Busque [[TOOL:teste.buscar:{"termo":"${t}"}]] [[RESPOSTA:Achei [1].]]`;
    assert.equal((await H.rodar(c, pedido('abcdefghij'))).ok, true, 'padrão da empresa: 500 caracteres');
    await definirParametro(tenantA, 'ia.tool.string_max_caracteres', 5, tx);
    const res = H.falhou(await H.rodar(c, pedido('abcdefghij')), 400, 'AI_TOOL_ARGS_INVALID', 'BLOCKED');
    assert.equal((await H.chamadas(res.runId, tx))[0].blocked_reason, 'SCHEMA');
  });
});

test('m9d020_saida_sanitizada_remove_imagem_com_query_e_registra_o_evento', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    // O limiar de bloqueio da empresa (ia.injecao.limiar_bloqueio) em 1,0 deixa a entrada passar só com alerta, para chegar à varredura da saída.
    await definirParametro(tenantA, 'ia.injecao.limiar_bloqueio', 1, tx);
    // A marcação de imagem com query é canal de exfiltração: sai sempre da resposta, mesmo se o modelo a produziu "de boa-fé".
    const res = await H.rodar(c, 'Cumprimente [[RESPOSTA:Olá! ![pixel](https://rastreio.test/p?dados=sim) até logo.]]', { taskType: 'conversa' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.doesNotMatch(res.answer, /rastreio\.test/);
    assert.match(res.answer, /\[imagem removida\]/);
    const eventos = await H.q("SELECT * FROM integration.outbox_events WHERE event_type = 'ai.security.prompt_injection_detected' ORDER BY occurred_at DESC LIMIT 1", {}, tx);
    assert.ok(JSON.stringify(eventos[0]).includes('OUTPUT_SANITIZED'));
  });
});

test('m9d020_replay_e_andamento_da_chamada_de_tool', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { def, execucoes } = toolContadora();
    const c = await H.cenario(tenantA, tx, { tools: ['teste.lerAlgo'], extraDefs: [def] });
    const claim = (status) => async (e) => {
      if (e.event !== 'start' || e.step !== 7 || e.done) return;
      e.done = true;
      const recorder = createToolCallRecorder({ ctx: c.ctx, transaction: tx, runId: e.runId });
      await recorder.claim({ toolName: 'teste.lerAlgo', tool: c.registry.get('teste.lerAlgo'), args: {}, seq: 1 });
      if (status) await recorder.record({ status, output: { valor: 'dado-de-teste' } });
    };
    // Chamada já concluída no mesmo run e na mesma ordem (seq 1) com os mesmos argumentos: replay, a tool NÃO executa de novo.
    c.orch.deps.onSpan = claim('SUCCEEDED');
    const res = await H.rodar(c, 'Leia [[TOOL:teste.lerAlgo:{}]] [[RESPOSTA:ok [1].]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(execucoes.length, 0, 'replay: a tool não executou');
    const linhas = await H.chamadas(res.runId, tx);
    assert.equal(linhas.length, 1, 'uma só linha: o replay não cria outra');
    assert.equal(linhas[0].status, 'SUCCEEDED');
    // Chamada ainda em andamento (REQUESTED): 409 AI_TOOL_CALL_IN_PROGRESS e o run termina FAILED.
    const d = await H.cenario(tenantA, tx, { tools: ['teste.lerAlgo'], extraDefs: [def] });
    d.orch.deps.onSpan = claim(null);
    const emAndamento = H.falhou(await H.rodar(d, 'Leia [[TOOL:teste.lerAlgo:{}]] [[RESPOSTA:ok [1].]]'), 409, 'AI_TOOL_CALL_IN_PROGRESS', 'FAILED');
    assert.equal((await H.lerRun(emAndamento.runId, tx)).error_code, 'AI_TOOL_CALL_IN_PROGRESS');
  });
});

test('m9d020_repetir_o_pedido_de_run_em_andamento_devolve_409', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    // Run da mesma chave que ainda está RUNNING (aberto por outro caminho): repetir não executa nada e responde 409.
    const texto = 'Classifique [[RESPOSTA:ok]]';
    const { requestHashOf, parseRunInput } = require('../../../src/features/ai/orchestrator/flow/flow.input');
    const parsed = parseRunInput({ agentCode: c.code, purpose: 'Consulta de teste', input: texto, taskType: 'classificar' });
    await runs.startRun(c.ctx, { stamp: { agentCode: c.code }, purpose: 'Consulta de teste', inputSummary: texto, idempotencyKey: 'andamento-1', requestHash: requestHashOf(parsed) }, tx);
    const res = await H.rodar(c, texto, { taskType: 'classificar', idempotencyKey: 'andamento-1' });
    H.falhou(res, 409, 'AI_TOOL_CALL_IN_PROGRESS');
    assert.equal(res.replayed, true);
  });
});
