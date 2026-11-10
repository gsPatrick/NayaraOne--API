'use strict';

// M9-D414 — executores das 7 ações do catálogo: cada um chama o serviço da lista e entrega a action_key como Idempotency-Key.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktRunner');
const nay = require('../../../src/features/marketing/content/pipeline.nayPort');

let tenant;
before(async () => { ({ tenantA: tenant } = await env.prepararTenants()); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.runner.reviewPort.clearReviewRequester(); nay.clearNayDraftProvider(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const receipts = (t, key) => env.q(t, 'SELECT action_type, action_key, destination_ref FROM marketing.automation_action_receipts WHERE action_key = :k', { k: key });

async function oneAction(t, action, { opportunity = true } = {}) {
  const person = await env.readyPerson(t, tenant);
  if (opportunity) await env.makeOpportunity(t, tenant, person, { stage: 'NEW' });
  await env.publishedFlow(t, tenant, { actions: [action] });
  const out = await env.run(t, tenant, env.eventFor(tenant, person));
  const row = await env.runRow(t, out.runs[0].runId);
  return { person, row, key: row.actions_result[0].action_key, entry: row.actions_result[0] };
}

test('executor_de_cada_tipo_de_acao_do_catalogo: as 7 acoes chamam o servico da lista com a action_key como Idempotency-Key', async () => {
  await inTx(async (t) => {
    const reviews = [];
    env.runner.reviewPort.registerReviewRequester(async (request) => { reviews.push(request); return { reviewRequestId: env.uid() }; });
    nay.registerNayDraftProvider(async () => ({ text: 'Texto', nayRunId: env.uid(), modelName: 'sandbox-m9d414' }));

    const send = await oneAction(t, env.SEND());
    assert.equal(send.entry.status, 'OK');
    const [msg] = await env.q(t, 'SELECT action_key FROM crm.messages WHERE person_id = :p AND direction = \'OUTBOUND\'', { p: send.person });
    assert.equal(msg.action_key, send.key, 'SEND_MESSAGE: a coluna action_key da mensagem');

    const task = await oneAction(t, env.TASK());
    assert.equal(task.entry.status, 'OK', JSON.stringify(task.entry));
    assert.equal((await env.tasksByKey(t, task.key)).length, 1, 'CREATE_TASK: a coluna action_key da tarefa');

    const notify = await oneAction(t, { actionType: 'NOTIFY_USER', title: 'Lead novo QA-M9', body: 'Veja o lead.' });
    assert.equal(notify.entry.status, 'OK');
    assert.equal((await receipts(t, notify.key))[0].action_type, 'NOTIFY_USER');
    assert.equal((await env.q(t, "SELECT count(*)::int AS n FROM core.notifications WHERE title = 'Lead novo QA-M9' AND user_id = :u", { u: tenant.userId }))[0].n, 1);

    const draft = await oneAction(t, { actionType: 'CREATE_CONTENT_DRAFT', type: 'INSTITUTIONAL', title: 'Rascunho QA-M9', texto: 'Somos uma imobiliária de Salvador.' });
    assert.equal(draft.entry.status, 'OK', JSON.stringify(draft.entry));
    assert.equal((await receipts(t, draft.key)).length, 1);
    assert.equal((await env.q(t, "SELECT status FROM marketing.content_items WHERE title = 'Rascunho QA-M9'"))[0].status, 'DRAFT');

    const review = await oneAction(t, { actionType: 'REQUEST_REVIEW', platform: 'GOOGLE' });
    assert.equal(review.entry.status, 'OK');
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].idempotencyKey, review.key, 'REQUEST_REVIEW: o serviço recebe a chave');
    assert.equal(reviews[0].personId, review.person);

    const kase = await oneAction(t, { actionType: 'OPEN_CASE', caseType: 'COMPLAINT', description: 'Cliente reclamou do atendimento QA-M9.', severity: 'HIGH' });
    assert.equal(kase.entry.status, 'OK');
    assert.equal((await receipts(t, kase.key)).length, 1);
    // Reclamação HIGH é reclamação grave: nasce escalonada para a gerência (livro do Marco 3, §15).
    assert.equal((await env.q(t, "SELECT count(*)::int AS n FROM crm.feedback_cases WHERE person_id = :p AND status = 'ESCALATED'", { p: kase.person }))[0].n, 1);

    const stage = await oneAction(t, { actionType: 'UPDATE_CRM_STAGE_TAG', stage: 'QUALIFIED', temperature: 'HOT', nextAction: 'Ligar para o cliente', nextActionDueAt: '2026-12-01T12:00:00Z' });
    assert.equal(stage.entry.status, 'OK', JSON.stringify(stage.entry));
    assert.equal((await receipts(t, stage.key)).length, 1);
    const [opp] = await env.q(t, 'SELECT stage, temperature FROM crm.opportunities WHERE person_id = :p', { p: stage.person });
    assert.deepEqual([opp.stage, opp.temperature], ['QUALIFIED', 'HOT']);
  });
});

test('cada_acao_envia_action_key_como_idempotency_key: repetir a ação com a mesma chave não cria segundo registro (replay da run)', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant, { actions: [env.TASK(), { actionType: 'NOTIFY_USER', title: 'Aviso QA-M9 idempotente', body: 'x' }, { actionType: 'OPEN_CASE', caseType: 'COMPLAINT', description: 'Caso QA-M9 idempotente.' }] });
    const out = await env.run(t, tenant, env.eventFor(tenant, person));
    const row = await env.runRow(t, out.runs[0].runId);
    assert.deepEqual(row.actions_result.map((a) => a.status), ['OK', 'OK', 'OK']);
    // simula a perda do resultado gravado: a run volta a ter as ações PENDING e o replay NÃO duplica nenhum destino
    await env.q(t, "UPDATE marketing.automation_runs SET status = 'FAILED', actions_result = (SELECT jsonb_agg(jsonb_set(e, '{status}', '\"PENDING\"')) FROM jsonb_array_elements(actions_result) e) WHERE id = :id", { id: row.id });
    const replay = await env.runner.replayRun(row.id, tenant, t, { now: env.NOON_SP, mode: 'SANDBOX' });
    assert.equal(replay.status, 'COMPLETED');
    for (const a of row.actions_result) {
      if (a.type === 'CREATE_TASK') assert.equal((await env.tasksByKey(t, a.action_key)).length, 1);
      else assert.equal((await receipts(t, a.action_key)).length, 1, a.type);
    }
    assert.equal((await env.q(t, "SELECT count(*)::int AS n FROM core.notifications WHERE title = 'Aviso QA-M9 idempotente'"))[0].n, 1);
    assert.equal((await env.q(t, "SELECT count(*)::int AS n FROM crm.feedback_cases WHERE person_id = :p", { p: person }))[0].n, 1);
  });
});

test('acao_sem_servico_registrado_ou_com_dados_invalidos_falha_com_MKT_ACTION_FAILED (REQUEST_REVIEW sem a M9-D424, CREATE_TASK sem titulo)', async () => {
  await inTx(async (t) => {
    const review = await oneAction(t, { actionType: 'REQUEST_REVIEW' });
    assert.equal(review.row.status, 'FAILED');
    assert.equal(review.entry.error_code, 'MKT_ACTION_FAILED');
    const bad = await oneAction(t, env.TASK({ title: '' }));
    assert.equal(bad.entry.error_code, 'MKT_ACTION_FAILED');
  });
});

test('acao_que_estoura_o_timeout_fica_UNKNOWN e a run FAILED com MKT_ACTION_UNKNOWN (parametro marketing.runner.acao_timeout_s)', async () => {
  await inTx(async (t) => {
    await require('../../../src/features/settings/settings.service').upsertSetting('marketing.runner.acao_timeout_s', 1, tenant, tenant.userId, t);
    env.runner.reviewPort.registerReviewRequester(() => new Promise((resolve) => { setTimeout(resolve, 1500); }));
    const slow = await oneAction(t, { actionType: 'REQUEST_REVIEW' });
    assert.equal(slow.row.status, 'FAILED');
    assert.equal(slow.entry.status, 'UNKNOWN');
    assert.equal(slow.entry.error_code, 'MKT_ACTION_UNKNOWN');
  });
});

test('stopOnError falso: a falha de uma ação não impede as seguintes (a run termina FAILED)', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant, { actions: [env.TASK({ title: '', stopOnError: false }), env.TASK({ title: 'Segunda executa QA-M9' })] });
    const out = await env.run(t, tenant, env.eventFor(tenant, person));
    const row = await env.runRow(t, out.runs[0].runId);
    assert.deepEqual(row.actions_result.map((a) => a.status), ['FAILED', 'OK']);
    assert.equal(row.status, 'FAILED');
  });
});
