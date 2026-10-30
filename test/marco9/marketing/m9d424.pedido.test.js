'use strict';

// M9-D424 — o pedido na prática: consentimento, horário de silêncio, idempotência, retorno da plataforma, acompanhamento da entrega e isolamento entre empresas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const reviews = require('../../../src/features/marketing/automations/reviews');
const messaging = require('../../../src/features/marketing/publications/messaging');
const rv = require('../_helpers/mktReviews');

let tenant;
let tenantB;
let offVault;
before(async () => { ({ tenantA: tenant, tenantB } = await rv.prepararTenants()); offVault = rv.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const SANDBOX = { mode: 'SANDBOX' };
const send = async (t, person, score = 5) => { await rv.record(t, tenant, person, score, SANDBOX); return (await rv.requestOf(t, person))[0]; };

test('sem_opt_in_de_avaliacao_o_pedido_fica_suprimido: AVALIACAO exige OPT_IN, nada é enviado e não há evento', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant, { optIn: false });
    const request = await send(t, person);
    assert.deepEqual([request.status, request.error_code], ['SUPPRESSED', 'NO_CONSENT']);
    assert.equal((await rv.messagesOf(t, person)).length, 0);
    assert.equal((await rv.reviewEvents(t, request.id)).length, 0);
  });
});

test('horario_de_silencio_adia_o_pedido_e_o_executor_envia_depois_com_a_mesma_chave', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const { out } = await rv.record(t, tenant, person, 5, { ...SANDBOX, now: rv.NIGHT });
    const run = await rv.runRow(t, out.runs[0].runId);
    assert.equal(run.status, 'WAITING');
    assert.equal(run.actions_result[0].status, 'SCHEDULED');
    assert.equal(new Date(run.actions_result[0].due_at).toISOString(), rv.MORNING.toISOString());
    assert.deepEqual((await rv.requestOf(t, person)).map((r) => r.status), ['PENDING'], 'o pedido existe, ainda sem envio');
    assert.equal((await rv.messagesOf(t, person)).length, 0);
    await rv.runner.runDueActions(tenant, t, { now: rv.MORNING, mode: 'SANDBOX' });
    const requests = await rv.requestOf(t, person);
    assert.deepEqual(requests.map((r) => r.status), ['SENT'], 'o mesmo pedido, não um segundo');
    assert.equal((await rv.messagesOf(t, person)).length, 1);
    const done = await rv.runRow(t, run.id);
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.actions_result[0].action_key, run.actions_result[0].action_key);
  });
});

test('o_servico_na_porta_do_runner_e_idempotente: a mesma chave devolve o mesmo pedido e a mesma origem nunca gera dois', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const sat = await rv.satisfaction(t, tenant, person, 5);
    const base = { tenant, transaction: t, personId: person, platform: 'GOOGLE', channel: 'AUTO', correlationId: rv.uid(), mode: 'SANDBOX', now: rv.NOON_SP, context: { eventId: sat.outboxId } };
    const key = rv.sha('chave-d424');
    const first = await reviews.requestReview({ ...base, idempotencyKey: key });
    assert.ok(first.reviewRequestId);
    const again = await reviews.requestReview({ ...base, idempotencyKey: key });
    assert.equal(again.reviewRequestId, first.reviewRequestId);
    const sameOrigin = await reviews.requestReview({ ...base, idempotencyKey: rv.sha('outra-chave-d424') });
    assert.equal(sameOrigin.reviewRequestId, first.reviewRequestId, 'uma review_request por (pessoa, origem)');
    assert.equal((await rv.requestOf(t, person)).length, 1);
    assert.equal((await rv.messagesOf(t, person)).length, 1);
  });
});

test('o_mesmo_evento_de_satisfacao_duas_vezes_gera_um_pedido', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const sat = await rv.satisfaction(t, tenant, person, 5);
    await rv.run(t, tenant, sat.input, SANDBOX);
    assert.equal((await rv.run(t, tenant, sat.input, SANDBOX)).duplicate, true);
    const redelivered = { ...sat.input, eventId: rv.uid() };
    await rv.run(t, tenant, redelivered, SANDBOX);
    assert.equal((await rv.requestOf(t, person)).length, 1);
    assert.equal((await rv.messagesOf(t, person)).length, 1);
  });
});

test('retorno_da_plataforma_grava_nota_publica_e_completa_o_pedido: plataforma, public_rating e completed_at só pelo retorno', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const request = await send(t, person);
    assert.equal(request.public_rating, null);
    assert.equal(request.completed_at, null);
    const done = await reviews.recordPlatformReturn({ tenant, transaction: t, actor: tenant.userId, reviewRequestId: request.id, platform: 'google', rating: 5, completedAt: '2026-11-12T15:00:00Z' });
    assert.equal(done.publicRating, 5);
    const [row] = await rv.requestOf(t, person);
    assert.deepEqual([row.status, row.platform, row.public_rating], ['COMPLETED', 'GOOGLE', 5]);
    assert.equal(new Date(row.completed_at).toISOString(), '2026-11-12T15:00:00.000Z');
    assert.equal((await reviews.recordPlatformReturn({ tenant, transaction: t, actor: tenant.userId, reviewRequestId: request.id, platform: 'GOOGLE', rating: 1 })).replay, true, 'o retorno repetido não muda nada');
    assert.equal((await rv.requestOf(t, person))[0].public_rating, 5);
    await assert.rejects(reviews.recordPlatformReturn({ tenant, transaction: t, actor: null, reviewRequestId: request.id, platform: 'GOOGLE', rating: 9 }), (e) => e.statusCode === 422 && e.code === 'MKT_REVIEW_RATING_INVALID');
  });
});

test('retorno_da_plataforma_so_conclui_pedido_enviado: pedido negativo ou nunca enviado recebe 409', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const negative = await send(t, person, 1);
    await assert.rejects(reviews.recordPlatformReturn({ tenant, transaction: t, actor: null, reviewRequestId: negative.id, platform: 'GOOGLE', rating: 5 }), (e) => e.statusCode === 409 && e.code === 'MKT_REVIEW_NOT_REQUESTED');
    await assert.rejects(reviews.recordPlatformReturn({ tenant, transaction: t, actor: null, reviewRequestId: rv.uid(), platform: 'GOOGLE', rating: 5 }), (e) => e.statusCode === 404);
  });
});

test('a_entrega_da_mensagem_acompanha_o_pedido: DELIVERED confirma a entrega e falha depois do envio marca FAILED', async () => {
  await inTx(async (t) => {
    const delivered = await send(t, await rv.ready(t, tenant));
    const [msg] = await rv.q(t, 'SELECT external_message_id FROM crm.messages WHERE id = :id', { id: delivered.message_id });
    await messaging.applyDeliveryStatus({ tenant, channel: 'EMAIL', providerRef: msg.external_message_id, status: 'DELIVERED' }, t);
    assert.equal((await rv.q(t, 'SELECT status FROM marketing.review_requests WHERE id = :id', { id: delivered.id }))[0].status, 'DELIVERED');
    const failedPerson = await rv.readyPerson(t, tenant, { phone: null, optIn: ['AVALIACAO'] });
    const failed = await send(t, failedPerson);
    const [msg2] = await rv.q(t, 'SELECT external_message_id FROM crm.messages WHERE id = :id', { id: failed.message_id });
    await messaging.applyDeliveryStatus({ tenant, channel: 'EMAIL', providerRef: msg2.external_message_id, status: 'BOUNCED_SOFT' }, t);
    const [row] = await rv.q(t, 'SELECT status, error_code FROM marketing.review_requests WHERE id = :id', { id: failed.id });
    assert.deepEqual([row.status, row.error_code], ['FAILED', 'MKT_REVIEW_DELIVERY_FAILED']);
  });
});

test('o_pedido_e_auditado_antes_e_depois_e_isolado_por_empresa', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const request = await send(t, person);
    const trail = await rv.q(t, "SELECT action, before_json, after_json FROM audit.audit_log WHERE entity_type = 'marketing.review_request' AND entity_id = :id ORDER BY occurred_at, id", { id: request.id });
    assert.deepEqual(trail.map((a) => a.action), ['marketing.review_request.create', 'marketing.review_request.sent']);
    assert.equal(trail[1].before_json.status, 'PENDING');
    assert.equal(trail[1].after_json.status, 'SENT');
    const seen = await rv.asTenant(t, tenant, tenantB, () => rv.q(t, 'SELECT count(*)::int AS n FROM marketing.review_requests WHERE id = :id', { id: request.id }));
    assert.equal(seen[0].n, 0);
  });
});
