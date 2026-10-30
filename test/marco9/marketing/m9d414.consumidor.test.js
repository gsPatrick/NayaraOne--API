'use strict';

// M9-D414 — consumidor do outbox (passo 1), isolamento da tabela de recibos e o tick de agenda.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktRunner');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { TRIGGER_EVENTS } = require('../../../src/features/marketing/automations/catalog');

let tenant; let tenantB;
before(async () => { ({ tenantA: tenant, tenantB } = await env.prepararTenants()); });
after(async () => { await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);

test('o runner consome todos os eventos do catalogo de gatilhos pelo registro do outbox, com deduplicacao do inbox por eventId', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant, { actions: [env.TASK()] });
    const event = { id: env.uid(), eventType: env.EVENT, aggregateType: 'Opportunity', aggregateId: env.uid(), groupId: tenant.groupId, companyId: tenant.companyId, correlationId: env.uid(), payloadJson: { personId: person } };
    assert.deepEqual(await runEventConsumers(event, t), ['marketing.content.type_triggers'].filter(() => false).concat(['marketing.automation.runner']).filter((n) => n));
    const [{ n }] = await env.q(t, 'SELECT count(*)::int AS n FROM marketing.automation_runs WHERE subject_id = :p', { p: person });
    assert.equal(n, 1);
    await runEventConsumers(event, t); // reentrega do mesmo evento
    assert.equal((await env.q(t, 'SELECT count(*)::int AS n FROM marketing.automation_runs WHERE subject_id = :p', { p: person }))[0].n, 1);
    assert.equal((await env.q(t, 'SELECT count(*)::int AS n FROM core.tasks WHERE action_key IS NOT NULL AND title = :t', { t: 'Ligar para o lead QA-M9' }))[0].n, 1);
    for (const type of TRIGGER_EVENTS) assert.ok(env.runner.consumedEventTypes().includes(type), type);
  });
});

test('o sujeito vem do payload do evento (personId) ou do agregado das pessoas', async () => {
  const { resolveSubject } = env.runner;
  const id = env.uid();
  assert.deepEqual(resolveSubject({ eventType: 'person.created', aggregateId: id, payloadJson: {} }), { type: 'PERSON', id });
  assert.deepEqual(resolveSubject({ eventType: env.EVENT, aggregateId: env.uid(), payloadJson: { personId: id } }), { type: 'PERSON', id });
  assert.equal(resolveSubject({ eventType: 'property.published', aggregateId: env.uid(), payloadJson: {} }), null);
});

test('a tabela de recibos das acoes tem RLS: a outra empresa nao enxerga nem grava', async () => {
  await inTx(async (t) => {
    const person = await env.readyPerson(t, tenant);
    await env.publishedFlow(t, tenant, { actions: [{ actionType: 'NOTIFY_USER', title: 'Recibo QA-M9', body: 'x' }] });
    const out = await env.run(t, tenant, env.eventFor(tenant, person));
    const key = (await env.runRow(t, out.runs[0].runId)).actions_result[0].action_key;
    assert.equal((await env.q(t, 'SELECT 1 AS ok FROM marketing.automation_action_receipts WHERE action_key = :k', { k: key })).length, 1);
    const seenByB = await env.asTenant(t, tenant, tenantB, () => env.q(t, 'SELECT 1 AS ok FROM marketing.automation_action_receipts WHERE action_key = :k', { k: key }));
    assert.equal(seenByB.length, 0);
    await env.asTenant(t, tenant, tenantB, async () => {
      await sequelize.query('SAVEPOINT rls', { transaction: t });
      await assert.rejects(env.q(t, `INSERT INTO marketing.automation_action_receipts (group_id, company_id, run_id, action_key, action_type) VALUES (:g, :c, :r, :k, 'NOTIFY_USER')`, { g: tenant.groupId, c: tenant.companyId, r: out.runs[0].runId, k: env.sha('x') }));
      await sequelize.query('ROLLBACK TO SAVEPOINT rls', { transaction: t });
    });
  });
});

test('tick de agenda: o fluxo SCHEDULE gera um evento sintetico sched:{fluxo}:{janela} e a run e idempotente por janela', async () => {
  await inTx(async (t) => {
    const flow = await env.publishedFlow(t, tenant, { triggerType: 'SCHEDULE', triggerConfig: { cron: '0 8 * * *', timeZone: 'America/Sao_Paulo' }, eventType: undefined, actions: [env.TASK({ title: 'Tarefa da agenda QA-M9' })] });
    const now = new Date('2026-11-10T11:00:20Z'); // 08:00 em São Paulo
    const first = await env.runner.runScheduleTick(tenant, t, { now, mode: 'SANDBOX' });
    assert.equal(first.created, 1);
    const [run] = await env.q(t, 'SELECT trigger_event_id, subject_id, status FROM marketing.automation_runs WHERE automation_version_id = :v', { v: flow.versionId });
    assert.equal(run.trigger_event_id, `sched:${flow.flowId}:2026-11-10T11:00:00.000Z`);
    assert.equal(run.subject_id, null);
    assert.equal(run.status, 'COMPLETED');
    const again = await env.runner.runScheduleTick(tenant, t, { now: new Date('2026-11-10T11:00:50Z'), mode: 'SANDBOX' });
    assert.equal(again.created, 0, 'a mesma janela não roda duas vezes');
    const other = await env.runner.runScheduleTick(tenant, t, { now: new Date('2026-11-10T12:30:00Z'), mode: 'SANDBOX' });
    assert.equal(other.created, 0, 'fora da janela do cron nada roda');
  });
});
