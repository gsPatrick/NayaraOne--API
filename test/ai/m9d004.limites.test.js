'use strict';

// M9-D004 — limites por agente: tool calls, tokens, taxa por usuário, resolução do limite (agente vence parâmetro) e rastreio da versão.
// Provider/orquestrador reais são de D010/D020: aqui o guarda é exercitado com um modelo sandbox de resposta fixa.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../testHelpers');
const { upsertSetting } = require('../../src/features/settings/settings.service');
const agents = require('../../src/features/ai/agents');
const {
  carregarPessoas, sequelize, ctxDe, BASE_AGENT, FERRAMENTA, prepararTenants, uid,
} = require('../helpers/aiAgents');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

async function agenteAtivo(tx, extra = {}) {
  const ctx = ctxDe(tenantA); const code = `T_${uid().slice(0, 8).toUpperCase()}`;
  await upsertSetting('ia.agente.avaliacao_verde_obrigatoria', false, ctx, ctx.userId, tx);
  await agents.createVersion(ctx, code, { ...BASE_AGENT, tools: [FERRAMENTA], ...extra }, tx);
  await agents.homologate(ctxDe(tenantA), code, 1, {}, tx);
  await agents.activate(ctx, code, 1, tx);
  return { ctx, agente: await agents.resolveActiveAgent(code, ctx, tx) };
}

test('m9d004_run_grava_agent_version', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { ctx, agente } = await agenteAtivo(tx);
    const guarda = await agents.AgentRunGuard.create(agente, ctx, tx);
    assert.deepEqual(guarda.stamp(), { agentId: agente.id, agentCode: agente.code, agentVersion: 1 });
  });
});

test('m9d004_limite_tool_calls_bloqueia_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { ctx, agente } = await agenteAtivo(tx);
    const guarda = await agents.AgentRunGuard.create(agente, ctx, tx);
    assert.equal(guarda.limits.maxToolCallsPorRun, 5, 'padrão do parâmetro ia.agente.max_tool_calls_por_run');
    for (let i = 0; i < 5; i += 1) guarda.beforeToolCall(FERRAMENTA.toolName);
    assert.equal(guarda.toolCalls, 5);
    let err;
    try { guarda.beforeToolCall(FERRAMENTA.toolName); } catch (e) { err = e; }
    assert.ok(err, 'a sexta chamada deve ser barrada');
    assert.equal(err.code, 'AI_TOOL_LIMIT_EXCEEDED');
    assert.deepEqual(err.details, { runStatus: 'BLOCKED', blockedReason: 'TOOL_LIMIT' });
    assert.equal(guarda.toolCalls, 5, 'a chamada barrada não conta');
    // A allowlist vem antes do limite.
    assert.throws(() => guarda.beforeToolCall('fin.pagar'), (e) => e.code === 'AI_TOOL_NOT_ALLOWED');
  });
});

test('m9d004_estouro_de_tool_e_token_devolve_422_com_codigo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { ctx, agente } = await agenteAtivo(tx);
    const guarda = await agents.AgentRunGuard.create(agente, ctx, tx);
    assert.equal(guarda.limits.maxTokensRun, 8000);
    guarda.beforeModelCall(); // acumulado 0
    guarda.recordUsage({ tokensIn: 5000, tokensOut: 3000 }); // 8000: no teto, ainda não passou
    guarda.beforeModelCall();
    guarda.recordUsage({ tokensIn: 1, tokensOut: 0 }); // 8001: passou
    let err;
    try { guarda.beforeModelCall(); } catch (e) { err = e; }
    assert.equal(err.statusCode, 422);
    assert.equal(err.code, 'AI_TOKEN_LIMIT_EXCEEDED');
    assert.match(err.message, /A NAY atingiu o limite de processamento desta consulta\./);
    assert.deepEqual(err.details, { runStatus: 'FAILED', blockedReason: 'TOKEN_LIMIT' });

    const g2 = await agents.AgentRunGuard.create(agente, ctx, tx);
    for (let i = 0; i < 5; i += 1) g2.beforeToolCall(FERRAMENTA.toolName);
    try { g2.beforeToolCall(FERRAMENTA.toolName); } catch (e) { err = e; }
    assert.equal(err.statusCode, 422);
    assert.match(err.message, /A NAY atingiu o limite de ferramentas por consulta\./);
  });
});

test('m9d004_limite_da_versao_vence_o_parametro_da_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    await upsertSetting('ia.agente.max_tool_calls_por_run', 2, ctx, ctx.userId, tx);
    await upsertSetting('ia.agente.max_tokens_run', 1000, ctx, ctx.userId, tx);
    await upsertSetting('ia.agente.timeout_ms', 5000, ctx, ctx.userId, tx);
    const { agente } = await agenteAtivo(tx);
    const doParametro = await agents.AgentRunGuard.create(agente, ctx, tx);
    assert.deepEqual(
      [doParametro.limits.maxToolCallsPorRun, doParametro.limits.maxTokensRun, doParametro.limits.timeoutMs],
      [2, 1000, 5000]
    );
    const { agente: proprio } = await agenteAtivo(tx, { limits: { max_tool_calls_por_run: 9, timeout_ms: 7000 } });
    const g = await agents.AgentRunGuard.create(proprio, ctx, tx);
    assert.deepEqual([g.limits.maxToolCallsPorRun, g.limits.maxTokensRun, g.limits.timeoutMs], [9, 1000, 7000]);
  });
});

test('m9d004_taxa_por_usuario_devolve_429', () => {
  // DI-IA-LEVE-5: a taxa vale pelo contador de banco (runs recentes da pessoa); o limitador em memória saiu.
  const guarda = new agents.AgentRunGuard({ code: 'X' }, { companyId: 'c', userId: 'u1' }, { maxRunsPorMinutoUsuario: 10 });
  guarda.assertRateCount(9);
  assert.throws(() => guarda.assertRateCount(10), (e) => e.statusCode === 429 && e.code === 'AI_RATE_LIMITED');
});
