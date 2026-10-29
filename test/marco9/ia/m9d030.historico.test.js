'use strict';

// M9-D030 — o chat pelo serviço (provider sandbox, nayara_runtime, rollback): o histórico da sessão entra só como entrada do run (últimas
// ia.chat.max_mensagens, redigidas), o replay do chat devolve replayed=true sem novo custo e o run em andamento responde 409.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { definirParametro } = require('../_helpers/iaOrcamento');
const { espiaRegistry } = require('../_helpers/iaEspia');
const H = require('../_helpers/iaOrquestrador');
const { executeRequest, chatPurpose } = require('../../../src/features/ai/runApi');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { requestHashOf } = require('../../../src/features/ai/orchestrator/flow/flow.input');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const conversar = (c, message, extra = {}, deps) => executeRequest({ kind: 'CHAT', agentCode: c.code, body: { message, ...extra } }, c.auth, c.tx, { ...c.orch.deps, ...deps });
const textoDoPedido = (pedido) => pedido.messages.map((m) => m.content).join('\n');

test('m9d030_chat_historico_so_como_entrada_ultimas_n_mensagens_redigidas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await H.cenario(tenantA, tx, { agentOver: { limits: { max_runs_por_minuto_usuario: 100 } }, deps: { registry } });
    const memoriasAntes = (await H.q('SELECT count(*)::int AS n FROM ai.memories WHERE company_id = :c', { c: tenantA.companyId }, tx))[0].n;
    await definirParametro(tenantA, 'ia.chat.max_mensagens', 2, tx);
    const um = await conversar(c, 'Primeira pergunta sobre aluguel [[RESPOSTA:Resposta da primeira.]]');
    const conversa = um.conversationId;
    await conversar(c, 'Segunda pergunta sobre venda [[RESPOSTA:Resposta da segunda.]]', { conversationId: conversa });
    await conversar(c, 'Meu CPF é 529.982.247-25 e a terceira pergunta [[RESPOSTA:Resposta da terceira.]]', { conversationId: conversa });
    pedidos.length = 0;
    await conversar(c, 'Quarta pergunta [[RESPOSTA:Resposta da quarta.]]', { conversationId: conversa });
    const prompt = textoDoPedido(pedidos[0]);
    assert.ok(prompt.includes('terceira pergunta'), 'a mensagem mais recente do histórico entra');
    assert.ok(prompt.includes('Resposta da terceira'), 'a resposta da NAY também entra');
    assert.ok(!prompt.includes('Primeira pergunta') && !prompt.includes('Segunda pergunta'), 'só as últimas ia.chat.max_mensagens (2)');
    assert.ok(!prompt.includes('529.982.247-25'), 'o histórico entra redigido');
    assert.match(prompt, /REDIGIDO/);
    // Sem memória: nada foi gravado em ai.memories e o histórico não é tabela nova (é a entrada dos runs da conversa).
    assert.equal((await H.q('SELECT count(*)::int AS n FROM ai.memories WHERE company_id = :c', { c: tenantA.companyId }, tx))[0].n, memoriasAntes);
    assert.equal((await H.q('SELECT count(*)::int AS n FROM ai.ai_runs WHERE conversation_id = :id', { id: conversa }, tx))[0].n, 4);
    await definirParametro(tenantA, 'ia.chat.max_mensagens', 0, tx);
    pedidos.length = 0;
    await conversar(c, 'Quinta pergunta [[RESPOSTA:Resposta da quinta.]]', { conversationId: conversa });
    assert.ok(!textoDoPedido(pedidos[0]).includes('terceira pergunta'), 'com 0 mensagens nenhum histórico entra');
  });
});

test('m9d030_chat_replay_e_run_em_andamento', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: { limits: { max_runs_por_minuto_usuario: 100 } } });
    const a = await conversar(c, 'Olá [[RESPOSTA:Olá, tudo bem.]]', { idempotencyKey: 'chat-replay-1' });
    const b = await conversar(c, 'Olá [[RESPOSTA:Olá, tudo bem.]]', { idempotencyKey: 'chat-replay-1' });
    assert.equal(a.outcome.replayed, false);
    assert.equal(b.outcome.replayed, true);
    assert.equal(b.outcome.runId, a.outcome.runId);
    assert.deepEqual(b.outcome.cost, a.outcome.cost);
    // Run ainda RUNNING com a mesma chave e o mesmo pedido: 409 AI_TOOL_CALL_IN_PROGRESS.
    const input = 'Pedido demorado';
    await runs.startRun(c.ctx, {
      stamp: { agentCode: c.code }, purpose: chatPurpose(c.code), inputSummary: input, idempotencyKey: 'chat-andamento-1',
      requestHash: requestHashOf({ agentCode: c.code, purpose: chatPurpose(c.code), input, taskType: 'consulta' }),
    }, tx);
    const andamento = await conversar(c, input, { idempotencyKey: 'chat-andamento-1' });
    assert.equal(andamento.outcome.ok, false);
    assert.equal(andamento.outcome.error.status, 409);
    assert.equal(andamento.outcome.error.code, 'AI_TOOL_CALL_IN_PROGRESS');
  });
});
