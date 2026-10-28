'use strict';

// M9-D005 — registro de execução da NAY: iniciar, finalizar, fontes, idempotência, custo exato, leitura com permissão e
// eventos. Roda com nayara_runtime (RLS real) em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../testHelpers');
const { upsertSetting } = require('../../src/features/settings/settings.service');
const runs = require('../../src/modules/ai/orchestrator/runs');
const { sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants } = require('../helpers/aiRuns');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

async function rejeita(promessa, status, code) {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}
const comPerm = (ctx, ...permissions) => ({ ...ctx, permissions });
const novo = (ctx, extra = {}) => ({ agentName: 'NAY_TESTE', purpose: 'teste', inputSummary: 'pergunta', ...extra });

test('m9d005_idempotency_key_nao_duplica', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const chave = `k-${uid()}`;
    const a = await runs.startRun(ctx, novo(ctx, { idempotencyKey: chave, requestHash: 'a'.repeat(64) }), tx);
    const b = await runs.startRun(ctx, novo(ctx, { idempotencyKey: chave, requestHash: 'a'.repeat(64) }), tx);
    assert.equal(a.replay, false); assert.equal(b.replay, true); assert.equal(a.run.id, b.run.id);
    const [{ n }] = await q('SELECT count(*)::int AS n FROM ai.ai_runs WHERE idempotency_key = :k', { k: chave }, tx);
    assert.equal(n, 1);
    await rejeita(runs.startRun(ctx, novo(ctx, { idempotencyKey: chave, requestHash: 'b'.repeat(64) }), tx), 409, 'AI_RUN_IDEMPOTENCY_CONFLICT');
    // Repetir um run já finalizado devolve o mesmo, sem novo custo.
    await runs.finishRun(ctx, a.run.id, { status: 'COMPLETED', outputSummary: 'ok', tokensIn: 10, tokensOut: 5, priceIn: '0.000010', priceOut: '0.000030' }, tx);
    const c = await runs.startRun(ctx, novo(ctx, { idempotencyKey: chave, requestHash: 'a'.repeat(64) }), tx);
    assert.equal(c.replay, true); assert.equal(c.run.status, 'COMPLETED'); assert.equal(c.run.costAmount, '0.000250');
  });
  // Outra empresa pode usar a mesma chave.
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const r = await runs.startRun(comPerm(ctxDe(tenantB), 'ai:use'), novo({}, { idempotencyKey: 'k-igual' }), tx);
    assert.equal(r.replay, false);
  });
});

test('m9d005_custo_decimal_exato_seis_casas', async () => {
  assert.equal(runs.computeRunCost({ tokensIn: 1200, tokensOut: 300, priceIn: '0.000010', priceOut: '0.000030' }), '0.021000');
  assert.equal(runs.computeRunCost({ tokensIn: 3, tokensOut: 0, priceIn: '0.1', priceOut: '0' }), '0.300000');
  assert.equal(runs.computeRunCost({ tokensIn: 1, tokensOut: 1, priceIn: '0.0000005', priceOut: '0.0000004' }), '0.000001', 'arredonda meio para cima na sexta casa');
  assert.equal(runs.computeRunCost({ tokensIn: 0, tokensOut: 0, priceIn: '1', priceOut: '1' }), '0.000000');
  assert.throws(() => runs.computeRunCost({ tokensIn: 1.5, tokensOut: 0, priceIn: '1', priceOut: '1' }), { code: 'AI_RUN_INVALID' });
  assert.throws(() => runs.computeRunCost({ tokensIn: 1, tokensOut: 0, priceIn: '-1', priceOut: '1' }), { code: 'AI_RUN_INVALID' });
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const marca = `soma-${uid()}`;
    for (const p of [['0.1', 1], ['0.2', 1]]) {
      const { run } = await runs.startRun(ctx, novo(ctx, { inputSummary: marca }), tx);
      await runs.finishRun(ctx, run.id, { status: 'COMPLETED', outputSummary: 'ok', tokensIn: p[1], tokensOut: 0, priceIn: p[0], priceOut: '0' }, tx);
    }
    const [s] = await q('SELECT SUM(cost_amount)::text AS s FROM ai.ai_runs WHERE input_summary = :m', { m: marca }, tx);
    assert.equal(s.s, '0.300000');
  });
});

test('m9d005_fonte_sem_excerpt_completo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const { run } = await runs.startRun(ctx, novo(ctx), tx);
    const documento = 'Cláusula '.repeat(2000);
    const f1 = await runs.recordSource(ctx, run.id, { sourceType: 'DOCUMENT_CHUNK', sourceRef: 'doc:1', excerpt: documento, classification: 'INTERNAL', usedInAnswer: true, relevanceScore: 0.91 }, tx);
    assert.equal(f1.excerpt.length, 500, 'padrão do parâmetro ia.fonte.excerpt_max_caracteres');
    await upsertSetting('ia.fonte.excerpt_max_caracteres', 120, ctx, ctx.userId, tx);
    const f2 = await runs.recordSource(ctx, run.id, { sourceType: 'KNOWLEDGE_ENTRY', sourceRef: 'k:1', excerpt: documento }, tx);
    assert.equal(f2.excerpt.length, 120, 'o parâmetro da empresa vale');
    const f3 = await runs.recordSource(ctx, run.id, { sourceType: 'TOOL_RESULT', sourceRef: 't:1', excerpt: 'token Bearer abcdefghijklmnopqrstuvwxyz0123456789 fim' }, tx);
    assert.doesNotMatch(f3.excerpt, /abcdefghijklmnopqrstuvwxyz0123456789/, 'credencial não vai para o trecho');
    await rejeita(runs.recordSource(ctx, run.id, { sourceType: 'ARQUIVO', sourceRef: 'x' }, tx), 400, 'AI_RUN_INVALID');
    await rejeita(runs.recordSource(ctx, run.id, { sourceType: 'MEMORY', classification: 'SECRETO' }, tx), 400, 'AI_RUN_INVALID');
    const lida = await runs.getRun(comPerm(ctx, 'ai:use', 'ai:read'), run.id, tx);
    assert.equal(lida.sources.length, 3);
    assert.ok(lida.sources.every((s) => s.excerpt.length <= 500));
    await runs.finishRun(ctx, run.id, { status: 'COMPLETED', outputSummary: 'ok' }, tx);
    await rejeita(runs.recordSource(ctx, run.id, { sourceType: 'MEMORY', sourceRef: 'm' }, tx), 409, 'AI_RUN_IMMUTABLE');
  });
});

test('m9d005_empresa_b_404', async () => {
  let idA;
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    idA = (await runs.startRun(ctx, novo(ctx), tx)).run.id;
    assert.equal((await runs.getRun(ctx, idA, tx)).id, idA);
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const err = await rejeita(runs.getRun(comPerm(ctxDe(tenantB), 'ai:audit'), idA, tx), 404, 'AI_RUN_NOT_FOUND');
    assert.match(err.message, /Execução não encontrada/);
  });
  // O run de A nem existe dentro da transação de B (e o mesmo id inexistente dá o mesmo 404).
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    await rejeita(runs.getRun(comPerm(ctxDe(tenantB), 'ai:audit'), uid(), tx), 404, 'AI_RUN_NOT_FOUND');
    await rejeita(runs.getRun(comPerm(ctxDe(tenantB), 'ai:audit'), 'nao-e-uuid', tx), 404, 'AI_RUN_NOT_FOUND');
  });
});

test('m9d005_usuario_so_ve_proprio_run_sem_ai_audit', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const dono = comPerm(ctxDe(tenantA), 'ai:use', 'ai:read');
    const outro = comPerm(ctxDe(tenantA), 'ai:use', 'ai:read');
    const auditor = comPerm(ctxDe(tenantA), 'ai:audit');
    const semPermissao = comPerm(ctxDe(tenantA), 'ai:use');
    assert.notEqual(dono.userId, outro.userId);
    const { run } = await runs.startRun(dono, novo(dono), tx);
    assert.equal((await runs.getRun(dono, run.id, tx)).id, run.id);
    await rejeita(runs.getRun(outro, run.id, tx), 404, 'AI_RUN_NOT_FOUND');
    assert.equal((await runs.getRun(auditor, run.id, tx)).id, run.id, 'ai:audit lê todos da empresa');
    await rejeita(runs.getRun({ ...semPermissao, userId: dono.userId }, run.id, tx), 403, 'PERMISSION_DENIED');
  });
});

test('m9d005_ciclo_via_servico_estados_eventos_e_mensagem_de_bloqueio', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const eventos = async (id) => (await q("SELECT event_type FROM integration.outbox_events WHERE aggregate_type = 'AiRun' AND aggregate_id = :id ORDER BY created_at", { id }, tx)).map((e) => e.event_type);
    const ok = (await runs.startRun(ctx, novo(ctx), tx)).run;
    assert.equal(ok.status, 'RUNNING');
    const fim = await runs.finishRun(ctx, ok.id, { status: 'COMPLETED', outputSummary: 'ok', providerCode: 'sandbox', modelCode: 'sandbox-small', routingPath: 'SMALL_MODEL', latencyMs: 12, groundingStatus: 'GROUNDED', confidence: 0.8 }, tx);
    assert.equal(fim.providerCode, 'sandbox'); assert.equal(fim.modelCode, 'sandbox-small'); assert.ok(fim.finishedAt); assert.equal(fim.groundingStatus, 'GROUNDED');
    assert.deepEqual(await eventos(ok.id), ['ai.run.completed']);
    await rejeita(runs.finishRun(ctx, ok.id, { status: 'FAILED', errorCode: 'X' }, tx), 409, 'AI_RUN_IMMUTABLE');

    const falho = (await runs.startRun(ctx, novo(ctx), tx)).run;
    await runs.finishRun(ctx, falho.id, { status: 'FAILED', errorCode: 'PROVIDER_TIMEOUT' }, tx);
    assert.deepEqual(await eventos(falho.id), ['ai.run.failed']);

    const barrado = (await runs.startRun(ctx, novo(ctx), tx)).run;
    const b = await runs.finishRun(ctx, barrado.id, { status: 'BLOCKED', blockedReason: 'TOOL_LIMIT' }, tx);
    assert.match(b.message, /^A NAY não pôde concluir: /);
    assert.deepEqual(await eventos(barrado.id), [], 'BLOCKED não emite evento');
    await rejeita(runs.finishRun(ctx, (await runs.startRun(ctx, novo(ctx), tx)).run.id, { status: 'BLOCKED' }, tx), 400, 'AI_RUN_INVALID');

    const espera = (await runs.startRun(ctx, novo(ctx), tx)).run;
    const aguarda = await runs.finishRun(ctx, espera.id, { status: 'AWAITING_APPROVAL', outputSummary: 'proposta' }, tx);
    assert.equal(aguarda.finishedAt, null); assert.deepEqual(await eventos(espera.id), []);
    await runs.finishRun(ctx, espera.id, { status: 'COMPLETED' }, tx);
    assert.deepEqual(await eventos(espera.id), ['ai.run.completed']);
    const cancelado = (await runs.startRun(ctx, novo(ctx), tx)).run;
    await runs.finishRun(ctx, cancelado.id, { status: 'AWAITING_APPROVAL' }, tx);
    await runs.finishRun(ctx, cancelado.id, { status: 'CANCELLED' }, tx);
    assert.deepEqual(await eventos(cancelado.id), []);
    await rejeita(runs.finishRun(ctx, (await runs.startRun(ctx, novo(ctx), tx)).run.id, { status: 'CANCELLED' }, tx), 409, 'AI_RUN_TRANSITION');

    const [aud] = await q("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_type = 'AiRun' AND entity_id = :id", { id: ok.id }, tx);
    assert.ok(aud.n >= 2, 'início e fim auditados com antes/depois');
  });
});

test('m9d005_registra_run_com_agente_versao_e_roteamento_e_pai', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const [agente] = await q("SELECT id, code, version FROM ai.agents WHERE company_id IS NULL AND code = 'NAY_COMERCIAL'", {}, tx);
    const pai = (await runs.startRun(ctx, novo(ctx, { stamp: { agentId: agente.id, agentCode: agente.code, agentVersion: agente.version }, snapshotAt: '2026-10-28T10:00:00Z' }), tx)).run;
    assert.equal(pai.agentId, agente.id); assert.equal(pai.agentVersion, agente.version); assert.equal(pai.agentCode, 'NAY_COMERCIAL');
    const filho = (await runs.startRun(ctx, novo(ctx, { parentRunId: pai.id }), tx)).run;
    assert.equal(filho.parentRunId, pai.id);
    const f = await runs.finishRun(ctx, filho.id, { status: 'COMPLETED', routingPath: 'CACHE', cached: true, fallbackTrail: [{ from: 'a', to: 'b', reason: 'TIMEOUT' }], escalated: false }, tx);
    assert.equal(f.cached, true); assert.equal(f.routingPath, 'CACHE'); assert.equal(f.fallbackTrail.length, 1);
    await rejeita(runs.startRun(ctx, novo(ctx, { parentRunId: uid() }), tx), 404, 'AI_RUN_NOT_FOUND');
  });
});

test('m9d005_nays_deterministicas_gravam_run_valido_com_agente_e_rule', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const r = await runs.recordRuleRun(ctx, { agentName: 'NAY_FINANCEIRA', inputSummary: 'entrada', outputSummary: 'saida', toolCallsJson: { method: 'RULE_BASED' } }, tx);
    assert.equal(r.status, 'COMPLETED'); assert.equal(r.routingPath, 'RULE'); assert.equal(r.groundingStatus, 'GROUNDED');
    assert.equal(r.costAmount, '0.000000'); assert.ok(r.agentId, 'agente do sistema encontrado pelo código'); assert.equal(r.agentVersion, 1);
    const semAgente = await runs.recordRuleRun(ctx, { agentName: 'NAY_ESTOQUE_OCR', inputSummary: 'x', outputSummary: 'y', groundingStatus: 'NOT_APPLICABLE' }, tx);
    assert.equal(semAgente.agentId, null); assert.equal(semAgente.groundingStatus, 'NOT_APPLICABLE');
  });
});
