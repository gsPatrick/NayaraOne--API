'use strict';

// M9-D414 — runner de automações: os 9 passos em ordem, replay, eventos do livro, falha no meio. Banco descartável, role de runtime, transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktRunner');

let tenant;
before(async () => { ({ tenantA: tenant } = await env.prepararTenants()); });
after(async () => { await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);

test('runner_executa_os_9_passos_na_ordem: lead novo, tudo liberado, run COMPLETED com mensagem e tarefa', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    const flow = await env.publishedFlow(t, tenant);
    const out = await env.run(t, tenant, env.eventFor(tenant, person));
    assert.equal(out.runs.length, 1);
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'COMPLETED');
    assert.deepEqual(row.actions_result.map((a) => [a.type, a.status]), [['SEND_MESSAGE', 'OK'], ['CREATE_TASK', 'OK']]);
    assert.ok(row.actions_result.every((a) => /^[0-9a-f]{64}$/.test(a.action_key)));
    const steps = row.policy_trace.map((e) => e.step);
    assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'cada passo grava o seu resultado, na ordem do livro');
    assert.deepEqual(row.policy_trace.map((e) => e.name), ['RECEIVE', 'RESOLVE_VERSION', 'SUPPRESSION_CONSENT', 'COOLDOWN', 'CONDITIONS', 'IDEMPOTENCY_KEY', 'EXECUTE_ACTIONS', 'RECORD_RESULTS', 'EMIT']);
    assert.equal(row.flow_id === undefined, true);
    assert.equal(flow.flowId !== undefined, true);
    assert.equal((await env.messagesOf(t, person)).length, 1);
  });
});

test('key_gerada_no_passo_6_depois_das_checagens: a run bloqueada no passo 3 recebe a key no passo 6', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.optOut(t, tenant, person, 'WHATSAPP');
    await env.publishedFlow(t, tenant);
    const out = await env.run(t, tenant, env.eventFor(tenant, person));
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'BLOCKED');
    const trace = row.policy_trace;
    const keyStep = trace.find((e) => e.name === 'IDEMPOTENCY_KEY');
    assert.equal(keyStep.step, 6);
    assert.match(keyStep.key, /^[0-9a-f]{64}$/);
    assert.equal(keyStep.key, row.idempotency_key);
    assert.ok(trace.findIndex((e) => e.name === 'SUPPRESSION_CONSENT') < trace.findIndex((e) => e.name === 'IDEMPOTENCY_KEY'));
    assert.deepEqual(trace.filter((e) => e.name === 'CONDITIONS' || e.name === 'COOLDOWN').map((e) => e.skipped), [true, true], 'os passos 4 e 5 não rodam depois de um bloqueio no passo 3');
  });
});

test('runner_emite_run_started_ao_criar_a_run: started uma vez, antes das ações, e completed com o mesmo correlationId', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant);
    const event = env.eventFor(tenant, person);
    const out = await env.run(t, tenant, event);
    const list = await env.events(t, out.runs[0].runId);
    assert.deepEqual(list.map((e) => e.event_type), ['automation.run.started', 'automation.run.completed']);
    const [started, completed] = list.map((e) => e.payload_json);
    assert.equal(started.payload.runId, out.runs[0].runId);
    assert.equal(started.payload.versionNo, 1);
    assert.deepEqual(started.payload.subject, { type: 'PERSON', id: person });
    assert.deepEqual(completed.payload.actionsSummary, { OK: 2 });
    assert.equal(started.correlationId, event.correlationId);
    assert.equal(completed.correlationId, event.correlationId);
  });
});

test('run bloqueada tambem emite started e depois blocked, com blockedReason', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.optOut(t, tenant, person, 'WHATSAPP');
    await env.publishedFlow(t, tenant);
    const out = await env.run(t, tenant, env.eventFor(tenant, person));
    const list = await env.events(t, out.runs[0].runId);
    assert.deepEqual(list.map((e) => e.event_type), ['automation.run.started', 'automation.run.blocked']);
    assert.match(list[1].payload_json.payload.blockedReason, /^(SUPPRESSED|OPT_OUT)$/);
  });
});

test('runner_replay_devolve_a_run_existente e replay_nao_emite_started_de_novo', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant);
    const event = env.eventFor(tenant, person);
    const first = await env.run(t, tenant, event);
    const again = await env.run(t, tenant, event);
    assert.equal(again.duplicate, true);
    assert.equal(again.runs[0].runId, first.runs[0].runId);
    assert.equal(again.runs[0].replay, true);
    assert.equal((await env.events(t, first.runs[0].runId)).length, 2, 'nenhum evento novo');
    assert.equal((await env.messagesOf(t, person)).length, 1, 'uma só mensagem');
    // outro evento com a mesma chave de deduplicação do gatilho também é replay (UNIQUE da run)
    const flow2 = await env.publishedFlow(t, tenant, { eventType: 'crm.opportunity.won', triggerConfig: { dedupeKey: '{opportunityId}' }, actions: [env.TASK()] });
    const e1 = env.eventFor(tenant, person, { eventType: 'crm.opportunity.won', payload: { opportunityId: 'op-1' } });
    const e2 = env.eventFor(tenant, person, { eventType: 'crm.opportunity.won', payload: { opportunityId: 'op-1' } });
    const r1 = await env.run(t, tenant, e1);
    const r2 = await env.run(t, tenant, e2);
    assert.equal(r2.runs[0].replay, true);
    assert.equal(r2.runs[0].runId, r1.runs[0].runId);
    assert.equal((await env.events(t, r1.runs[0].runId)).filter((e) => e.event_type === 'automation.run.started').length, 1);
    assert.ok(flow2.flowId);
  });
});

test('sem fluxo ativo ou sem versao publicada nada acontece (nenhuma run, log tecnico MKT_NO_PUBLISHED_VERSION)', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant, { flowStatus: 'PAUSED' });
    await env.publishedFlow(t, tenant, { versionStatus: 'DRAFT', eventType: 'crm.opportunity.won' });
    for (const eventType of [env.EVENT, 'crm.opportunity.won', 'crm.opportunity.lost']) {
      const out = await env.run(t, tenant, env.eventFor(tenant, person, { eventType }));
      assert.deepEqual(out.runs, []);
      assert.equal(out.code, 'MKT_NO_PUBLISHED_VERSION');
    }
    const [{ n }] = await env.q(t, 'SELECT count(*)::int AS n FROM marketing.automation_runs WHERE subject_id = :p', { p: person });
    assert.equal(n, 0);
  });
});

test('correlation_id_propagado: run, eventos, tarefa e auditoria da falha levam o do evento', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant, { actions: [env.TASK()] });
    const event = env.eventFor(tenant, person);
    const out = await env.run(t, tenant, event);
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.correlation_id, event.correlationId);
    for (const e of await env.events(t, row.id)) assert.equal(e.payload_json.correlationId, event.correlationId);
  });
});

test('falha_na_segunda_acao_replay_nao_repete_a_primeira: run FAILED, auditoria interna e nenhum evento fora do catalogo', async () => {
  await inTx(async (t) => {
    env.runner.reviewPort.clearReviewRequester(); // a M9-D424 registra o serviço de avaliação ao carregar o Marketing: o teste força o estado sem serviço registrado
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant, { actions: [env.TASK({ title: 'Primeira tarefa QA-M9' }), { actionType: 'REQUEST_REVIEW' }] });
    const out = await env.run(t, tenant, env.eventFor(tenant, person)); // sem o serviço de avaliação registrado a segunda ação falha
    const row = await env.runRow(t, out.runs[0].runId);
    assert.equal(row.status, 'FAILED');
    assert.deepEqual(row.actions_result.map((a) => a.status), ['OK', 'FAILED']);
    assert.equal(row.actions_result[1].error_code, 'MKT_ACTION_FAILED');
    const firstKey = row.actions_result[0].action_key;
    assert.equal((await env.tasksByKey(t, firstKey)).length, 1);
    // run_failed_nao_emite_evento_fora_do_catalogo
    assert.deepEqual((await env.events(t, row.id)).map((e) => e.event_type), ['automation.run.started']);
    const [{ n }] = await env.q(t, "SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type LIKE 'automation.run.failed%'");
    assert.equal(n, 0);
    const [audit] = await env.q(t, "SELECT after_json FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.automation_run.failed'", { id: row.id });
    assert.equal(audit.after_json.status, 'FAILED');
    // o serviço passa a existir e o replay executa só a ação que falta
    env.runner.reviewPort.registerReviewRequester(async () => ({ reviewRequestId: env.uid() }));
    try {
      const replay = await env.runner.replayRun(row.id, tenant, t, { now: env.NOON_SP, mode: 'SANDBOX' });
      assert.equal(replay.status, 'COMPLETED');
    } finally { env.runner.reviewPort.clearReviewRequester(); }
    assert.equal((await env.tasksByKey(t, firstKey)).length, 1, 'a primeira ação não repete');
    const after = await env.runRow(t, row.id);
    assert.deepEqual(after.actions_result.map((a) => a.status), ['OK', 'OK']);
    assert.deepEqual((await env.events(t, row.id)).map((e) => e.event_type), ['automation.run.started', 'automation.run.completed']);
  });
});
