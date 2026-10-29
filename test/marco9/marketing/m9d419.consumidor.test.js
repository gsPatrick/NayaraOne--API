'use strict';

// M9-D419 — consumidor de customer.opted_out: confere (e cria, sem reemitir) a supressão e cancela o que está agendado para a
// pessoa e o canal; uma vez por eventId; não recria supressão depois de novo OPT_IN. Banco descartável; rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { publishMarketingEvent } = require('../../../src/features/marketing/marketing.events.publish');
const { automatic } = require('../../../src/features/marketing/suppression');
const { canSend } = require('../../../src/features/marketing/suppression');
const env = require('../_helpers/mktOptOut');

const { readyPerson, makeFlowVersion, makeRun, sendAction, events, suppressions, outboxRow, NOON_SP, q } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);
const CONSUMER = 'marketing.optout.listener';
const emit = (t, p, extra = {}) => publishMarketingEvent({ type: 'customer.opted_out', payload: { personId: p, channel: 'EMAIL', purpose: 'ALL', source: 'QA_M9', occurredAt: new Date().toISOString(), ...extra }, tenant: A }, t);

test('consumidor_cria_a_supressao_que_faltar_sem_emitir_novo_evento_e_cancela_o_agendado', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    const flow = await makeFlowVersion(t, A);
    const runId = await makeRun(t, A, {
      versionId: flow.versionId, personId: p, status: 'WAITING',
      actions: [sendAction({ status: 'SCHEDULED', channel: 'EMAIL' }), sendAction({ status: 'SCHEDULED', channel: 'WHATSAPP' })],
    });
    await emit(t, p); // quem emitiu (por exemplo, outro serviço) não criou a supressão
    assert.equal((await suppressions(t, p)).length, 0);
    const ran = await runEventConsumers(await outboxRow(t, p), t);
    assert.ok(ran.includes(CONSUMER), `consumidores executados: ${ran}`);
    const [row] = await suppressions(t, p);
    assert.deepEqual([row.reason, row.channel, row.purpose, row.active, row.source], ['OPT_OUT', 'EMAIL', null, true, 'EVENT:QA_M9']);
    assert.equal((await events(t, p)).length, 1, 'o consumidor não reemite');
    assert.equal((await canSend(p, 'EMAIL', 'MARKETING', NOON_SP, { tenant: A, transaction: t })).reason, 'SUPPRESSED');
    const [runRow] = await q(t, 'SELECT status, blocked_reason, actions_result FROM marketing.automation_runs WHERE id = :id', { id: runId });
    assert.deepEqual([runRow.status, runRow.blocked_reason], ['BLOCKED', 'SUPPRESSED']);
    const byChannel = Object.fromEntries(runRow.actions_result.map((a) => [a.channel, a.status]));
    assert.deepEqual(byChannel, { EMAIL: 'SKIPPED', WHATSAPP: 'SCHEDULED' }, 'só o canal do opt-out é cancelado');
  });
});

test('consumidor_confere_idempotente_a_supressao_ja_criada_e_processa_cada_eventid_uma_vez', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    await automatic.handleUnsubscribeLink({ personId: p, channel: 'EMAIL' }, A, t);
    const row = await outboxRow(t, p);
    assert.ok((await runEventConsumers(row, t)).includes(CONSUMER));
    assert.equal((await suppressions(t, p)).length, 1, 'ON CONFLICT DO NOTHING: nenhuma duplicata');
    await runEventConsumers(row, t);
    assert.equal((await suppressions(t, p)).length, 1);
    assert.equal((await events(t, p)).length, 1);
    const seen = await q(t, "SELECT count(*)::int AS n FROM integration.integration_inbox WHERE consumer_name = :c AND event_id = :e", { c: CONSUMER, e: row.payloadJson.eventId });
    assert.equal(seen[0].n, 1, 'processado uma vez por eventId');
  });
});

test('consumidor_nao_recria_supressao_de_quem_deu_novo_opt_in_depois_do_pedido', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    await emit(t, p, { occurredAt: new Date(Date.now() - 3600 * 1000).toISOString() });
    await env.addConsent(t, A, p, 'EMAIL', 'ALL', 'OPT_IN', new Date());
    await runEventConsumers(await outboxRow(t, p), t);
    assert.equal((await suppressions(t, p)).length, 0);
  });
});
