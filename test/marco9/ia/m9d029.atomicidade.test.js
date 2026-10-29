'use strict';

// M9-D029 — evento na MESMA transação do dado (rollback desfaz os dois), falha ao gravar desfaz a operação, e nenhum payload com PII.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize: seq, withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas, ctxDe, q } = require('../../helpers/aiRuns');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { publishAiEvent } = require('../../../src/features/ai/events');
const { comPerm } = require('../_helpers/iaRecomendacao');
const { eventos, abrirRun, assertSemPii } = require('../_helpers/iaEventos');
const { comoTenant, rejeita } = require('../_helpers/iaOrcamento');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); await seq.close().catch(() => null); });

test('m9d029_rollback_desfaz_evento', async () => {
  const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
  const desfeito = await comoTenant(tenantA, async (tx) => {
    const run = await abrirRun(ctx, tx);
    await runs.finishRun(ctx, run.id, { status: 'COMPLETED', providerCode: 'sandbox', modelCode: 'm', routingPath: 'RULE', groundingStatus: 'GROUNDED' }, tx);
    assert.equal((await eventos('ai.run.completed', run.id, tx)).length, 1, 'dentro da transação o evento existe');
    return run.id;
  }).then(() => null, (e) => e);
  assert.equal(desfeito, null);
  // Transação que falha depois do evento: dado e evento somem juntos.
  let runId;
  await comoTenant(tenantA, async (tx) => {
    const run = await abrirRun(ctx, tx);
    runId = run.id;
    await runs.finishRun(ctx, run.id, { status: 'FAILED', errorCode: 'X' }, tx);
    throw new Error('falha depois do evento');
  }).catch(() => null);
  await comoTenant(tenantA, async (tx) => {
    assert.equal((await eventos('ai.run.failed', runId, tx)).length, 0, 'o evento foi desfeito');
    assert.equal((await q('SELECT 1 FROM ai.ai_runs WHERE id = :id', { id: runId }, tx)).length, 0, 'o dado também');
  });
});

test('m9d029_evento_incompleto_recusa_e_desfaz_a_operacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const err = await publishAiEvent(tenantA, 'ai.run.completed', { agentCode: 'NAY_FINANCEIRA' }, tx).then(() => null, (e) => e);
    assert.equal(err.statusCode, 500);
    assert.equal(err.code, 'AI_OUTBOX_EVENT_INCOMPLETE');
    assert.equal(err.message, 'Erro interno ao registrar o evento; a operação foi desfeita.');
    await rejeita(publishAiEvent(tenantA, 'ai.coisa.inventada', { x: 1 }, tx), 500, 'AI_OUTBOX_EVENT_INCOMPLETE');
    await rejeita(publishAiEvent(tenantA, 'ai.run.failed', { runId: 'nao-e-uuid', agentCode: 'A' }, tx), 500, 'AI_OUTBOX_EVENT_INCOMPLETE');
    // PII num campo de código é recusada em vez de ser enviada.
    await rejeita(publishAiEvent(tenantA, 'ai.run.failed', { runId: '00000000-0000-4000-8000-000000000001', agentCode: 'maria@x.com' }, tx), 500, 'AI_OUTBOX_EVENT_INCOMPLETE');
    await rejeita(publishAiEvent(tenantA, 'ai.run.failed', { runId: '00000000-0000-4000-8000-000000000001', agentCode: '111.444.777-35' }, tx), 500, 'AI_OUTBOX_EVENT_INCOMPLETE');
    await rejeita(publishAiEvent(tenantA, 'ai.run.failed', { runId: '00000000-0000-4000-8000-000000000001', agentCode: '11144477735' }, tx), 500, 'AI_OUTBOX_EVENT_INCOMPLETE');
    // Sem transação o evento não nasce (o outbox exige a transação do dado).
    await rejeita(publishAiEvent(tenantA, 'ai.run.failed', { runId: '00000000-0000-4000-8000-000000000001', agentCode: 'A' }, null), 500, 'INTEGRATION_OUTBOX_TRANSACTION_REQUIRED');
  });
  // Quando a gravação do evento falha dentro do ciclo do run, o finishRun falha e o run continua RUNNING (a transação do chamador desfaz tudo).
});

test('m9d029_payload_sem_pii', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use', 'ai:audit');
    const run = await abrirRun(ctx, tx); // a pergunta tem e-mail e CPF
    await runs.finishRun(ctx, run.id, { status: 'COMPLETED', outputSummary: 'Resposta para maria.silva@empresa.com.br, CPF 111.444.777-35', providerCode: 'sandbox', modelCode: 'm', routingPath: 'RULE', groundingStatus: 'GROUNDED' }, tx);
    const todos = await q("SELECT * FROM integration.outbox_events WHERE event_type LIKE 'ai.%' AND aggregate_id = :id", { id: run.id }, tx);
    assert.ok(todos.length >= 1);
    for (const e of todos) assertSemPii(assert, e);
    assert.ok(!JSON.stringify(todos).includes('maria.silva'));
  });
});
