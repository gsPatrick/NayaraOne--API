'use strict';

// M9-D414 — quiet hours e executor das ações adiadas (automationDueJob): a run espera, o executor reavalia o canSend inteiro e envia com a mesma action_key.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktRunner');

let tenant;
before(async () => { ({ tenantA: tenant } = await env.prepararTenants()); });
after(async () => { await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const due = (t, now) => env.runner.runDueActions(tenant, t, { now, mode: 'SANDBOX' });

async function nightRun(t, flowOver = {}) {
  const person = await env.readyPerson(t, tenant);
  const flow = await env.publishedFlow(t, tenant, flowOver);
  const out = await env.run(t, tenant, env.eventFor(tenant, person), { now: env.NIGHT });
  return { person, flow, runId: out.runs[0].runId, row: await env.runRow(t, out.runs[0].runId) };
}

test('quiet_hours_deixa_run_waiting_e_executor_dispara_na_janela: tarefa criada, mensagem SCHEDULED para 08:00, um unico completed', async () => {
  await inTx(async (t) => {
    const { person, runId, row } = await nightRun(t);
    assert.equal(row.status, 'WAITING');
    assert.equal(new Date(row.next_due_at).toISOString(), env.MORNING.toISOString());
    const send = env.sendEntry(row);
    assert.equal(send.status, 'SCHEDULED');
    assert.equal(new Date(send.due_at).toISOString(), env.MORNING.toISOString());
    assert.equal(env.entry(row, 'CREATE_TASK').status, 'OK', 'a tarefa interna executa na hora');
    assert.deepEqual((await env.events(t, runId)).map((e) => e.event_type), ['automation.run.started'], 'WAITING não emite término');
    assert.equal((await env.messagesOf(t, person)).length, 0);
    assert.equal((await due(t, new Date(env.MORNING.getTime() - 60000))).processed, 0, 'antes da janela nada acontece');
    assert.equal((await due(t, env.MORNING)).processed, 1);
    const after = await env.runRow(t, runId);
    assert.equal(after.status, 'COMPLETED');
    assert.equal(env.sendEntry(after).status, 'OK');
    assert.equal(env.sendEntry(after).action_key, send.action_key, 'a mesma action_key da ação original');
    assert.equal((await env.messagesOf(t, person)).length, 1);
    assert.deepEqual((await env.events(t, runId)).map((e) => e.event_type), ['automation.run.started', 'automation.run.completed']);
    assert.equal((await due(t, env.MORNING)).processed, 0, 'rodar de novo não envia nem emite outra vez');
    assert.equal((await env.events(t, runId)).length, 2);
  });
});

test('runner_cria_acao_reagendada_com_a_mesma_action_key: a ação adiada e a original compartilham a chave', async () => {
  await inTx(async (t) => {
    const { row } = await nightRun(t, { actions: [env.SEND()] });
    const entries = row.actions_result.filter((a) => a.type === 'SEND_MESSAGE');
    assert.equal(entries.length, 1, 'não nasce ação nova');
    assert.match(entries[0].action_key, /^[0-9a-f]{64}$/);
  });
});

test('acao_vencida_reavalia_cansend_e_pode_bloquear: opt-out durante a espera deixa SKIPPED e a run BLOCKED SUPPRESSED, nada enviado', async () => {
  await inTx(async (t) => {
    const { person, runId } = await nightRun(t);
    await env.optOut(t, tenant, person, 'WHATSAPP');
    await due(t, env.MORNING);
    const after = await env.runRow(t, runId);
    assert.equal(after.status, 'BLOCKED');
    assert.match(after.blocked_reason, /^(SUPPRESSED|OPT_OUT)$/);
    assert.equal(env.sendEntry(after).status, 'SKIPPED');
    assert.equal((await env.messagesOf(t, person)).length, 0);
    assert.deepEqual((await env.events(t, runId)).map((e) => e.event_type), ['automation.run.started', 'automation.run.blocked']);
  });
});

test('reavaliacao_na_janela: ainda em quiet hours reagenda; fluxo pausado vira AUTOMATION_PAUSED', async () => {
  await inTx(async (t) => {
    const first = await nightRun(t);
    const stillQuiet = new Date(env.NIGHT.getTime() + 3600 * 1000);
    await env.q(t, 'UPDATE marketing.automation_runs SET next_due_at = :d WHERE id = :id', { d: new Date(env.NIGHT.getTime() + 1000), id: first.runId });
    await env.q(t, "UPDATE marketing.automation_runs SET actions_result = (SELECT jsonb_agg(CASE WHEN e->>'type' = 'SEND_MESSAGE' THEN jsonb_set(e, '{due_at}', to_jsonb(CAST(:d AS text))) ELSE e END) FROM jsonb_array_elements(actions_result) e) WHERE id = :id", { d: new Date(env.NIGHT.getTime() + 1000).toISOString(), id: first.runId });
    await due(t, stillQuiet);
    const row = await env.runRow(t, first.runId);
    assert.equal(row.status, 'WAITING');
    assert.equal(new Date(row.next_due_at).toISOString(), env.MORNING.toISOString(), 'reagendada para a próxima janela livre');
    assert.equal(env.sendEntry(row).status, 'SCHEDULED');
    const second = await nightRun(t);
    await env.q(t, "UPDATE marketing.automation_flows SET status = 'PAUSED' WHERE id = :f", { f: second.flow.flowId });
    await due(t, env.MORNING);
    const paused = await env.runRow(t, second.runId);
    assert.equal(paused.status, 'BLOCKED');
    assert.equal(paused.blocked_reason, 'AUTOMATION_PAUSED');
    assert.equal(env.sendEntry(paused).status, 'SKIPPED');
  });
});

test('run_waiting_nao_e_reexecutada_pelo_timeout_de_run_travada: WAITING por 365 dias nao e tratada como STARTED travada', async () => {
  await inTx(async (t) => {
    const { runId } = await nightRun(t);
    await env.q(t, "UPDATE marketing.automation_runs SET started_at = :s WHERE id = :id", { s: new Date(env.NIGHT.getTime() - 365 * 24 * 3600 * 1000), id: runId });
    const result = await env.runner.recoverStuckRuns(tenant, t, { now: new Date(env.NIGHT.getTime() + 60000), mode: 'SANDBOX' });
    assert.equal(result.replayed, 0);
    const row = await env.runRow(t, runId);
    assert.equal(row.status, 'WAITING');
    const stuck = await env.runner.isRunStuck({ status: 'STARTED', startedAt: new Date(env.NIGHT.getTime() - 301 * 1000), finishedAt: null }, 300, env.NIGHT);
    assert.equal(stuck, true, 'a run STARTED há mais de 300 s é travada (regra da D415)');
  });
});

test('executor_das_acoes_adiadas: o mesmo vencimento processado duas vezes envia uma vez', async () => {
  await inTx(async (t) => {
    const { person, runId } = await nightRun(t);
    const a = await due(t, env.MORNING);
    const b = await due(t, env.MORNING); // a segunda rodada não encontra mais nada vencido
    assert.equal(a.processed + b.processed, 1);
    assert.equal((await env.messagesOf(t, person)).length, 1);
    assert.equal((await env.runRow(t, runId)).status, 'COMPLETED');
  });
});
