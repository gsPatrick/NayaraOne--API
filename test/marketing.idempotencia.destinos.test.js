'use strict';

// M9-D415 — destinos idempotentes (mensagem e tarefa do CRM com action_key UNIQUE), evento repetido e corrida de 2 conexões.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');

const { sequelize } = require('../src/models');
const idem = require('../src/modules/marketing/automations/idempotency');
const messagesService = require('../src/features/crm/messages.service');
const opportunityTasksService = require('../src/features/crm/opportunityTasks.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const peopleService = require('../src/features/people/person.service');
const { prepararTenants, mkFlow, mkAutoVersion, uid, q } = require('./helpers/marketingExecucao');
const { withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const msgPayload = (actionKey) => ({
  groupId: tenantA.groupId, companyId: tenantA.companyId, channel: 'EMAIL', direction: 'OUTBOUND', authorType: 'NAY', body: 'Confirmação QA-M9', actionKey,
});

test('mesmo_evento_2x_gera_uma_run_e_uma_mensagem', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const flowId = await mkFlow(tenantA, tx);
    const versionId = await mkAutoVersion(tenantA, tx, flowId);
    const subjectId = uid();
    const processar = async () => {
      const { run, replay } = await idem.startRun({
        tenant: tenantA, automationVersionId: versionId, eventId: 'evt-dup', triggerConfig: {}, payload: {},
        subjectType: 'PERSON', subjectId, correlationId: uid(),
      }, { transaction: tx });
      // o runner ruim ignora o replay e tenta enviar mesmo assim: a action_key segura
      const message = await messagesService.createMessage(msgPayload(idem.actionKey(run.idempotencyKey, 0, 'SEND_MESSAGE')), tenantA.userId, tx);
      return { run, replay, message };
    };
    const a = await processar();
    const b = await processar();
    assert.equal(a.replay, false);
    assert.equal(b.replay, true);
    assert.equal(a.run.id, b.run.id);
    assert.equal(a.message.id, b.message.id);
    const [{ n: runs }] = await q('SELECT count(*)::int AS n FROM marketing.automation_runs WHERE automation_version_id = :v', { v: versionId }, tx);
    const [{ n: msgs }] = await q('SELECT count(*)::int AS n FROM crm.messages WHERE action_key = :k', { k: a.run.idempotencyKey && idem.actionKey(a.run.idempotencyKey, 0, 'SEND_MESSAGE') }, tx);
    assert.equal(runs, 1);
    assert.equal(msgs, 1);
    assert.equal(a.message.actionKey, idem.actionKey(a.run.idempotencyKey, 0, 'SEND_MESSAGE'));
  });
});

test('action_key_e_unica_no_crm', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const key = idem.actionKey(uid(), 0, 'SEND_MESSAGE');
    const m1 = await messagesService.createMessage(msgPayload(key), tenantA.userId, tx);
    const m2 = await messagesService.createMessage(msgPayload(key), tenantA.userId, tx);
    assert.equal(m1.id, m2.id);
    // o banco recusa a duplicata mesmo por fora do serviço
    await sequelize.query('SAVEPOINT s1', { transaction: tx });
    await assert.rejects(
      sequelize.query(`INSERT INTO crm.messages (id, group_id, company_id, channel, direction, author_type, action_key) VALUES (gen_random_uuid(), :g, :c, 'EMAIL', 'OUTBOUND', 'NAY', :k)`,
        { replacements: { g: tenantA.groupId, c: tenantA.companyId, k: key }, transaction: tx }),
      (e) => e.parent?.code === '23505'
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });

    // tarefa do CRM: mesma regra
    const suffix = uniqueSuffix();
    const person = await peopleService.createPerson({ groupId: tenantA.groupId, companyId: tenantA.companyId, personType: 'PF', legalName: `Lead D415 ${suffix}` }, tenantA.userId, tx);
    const opp = await opportunitiesService.createOpportunity({
      groupId: tenantA.groupId, companyId: tenantA.companyId, personId: person.id, stage: 'QUALIFYING', nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 86400000),
    }, tenantA.userId, tx);
    const tkey = idem.actionKey(uid(), 1, 'CREATE_TASK');
    const t1 = await opportunityTasksService.createOpportunityTask(opp.id, { title: 'Retornar contato', actionKey: tkey }, tenantA.userId, tx);
    const t2 = await opportunityTasksService.createOpportunityTask(opp.id, { title: 'Retornar contato', actionKey: tkey }, tenantA.userId, tx);
    assert.equal(t1.id, t2.id);
    assert.equal(t1.actionKey, tkey);
    const [{ n }] = await q('SELECT count(*)::int AS n FROM core.tasks WHERE action_key = :k', { k: tkey }, tx);
    assert.equal(n, 1);
  });
});

test('duas_conexoes_mesmo_evento_uma_run', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) {
    t.skip('só roda no banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL)');
    return;
  }
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const subjectId = uid();
  let versionId; let flowId; let actionKey;
  const lancar = async (hold) => {
    const tx = await sequelize.transaction();
    try {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction: tx });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction: tx });
      const { run, replay } = await idem.startRun({
        tenant: tenantA, automationVersionId: versionId, eventId: 'evt-corrida', triggerConfig: {}, payload: {}, subjectType: 'PERSON', subjectId, correlationId: uid(),
      }, { transaction: tx });
      actionKey = idem.actionKey(run.idempotencyKey, 0, 'SEND_MESSAGE');
      const message = await messagesService.createMessage(msgPayload(actionKey), tenantA.userId, tx);
      if (hold) await new Promise((r) => setTimeout(r, 400));
      await tx.commit();
      return { replay, runId: run.id, messageId: message.id };
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  };
  try {
    await sequelize.transaction(async (tx) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction: tx });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction: tx });
      flowId = await mkFlow(tenantA, tx);
      versionId = await mkAutoVersion(tenantA, tx, flowId);
    });
    const [a, b] = await Promise.all([lancar(true), (async () => { await new Promise((r) => setTimeout(r, 100)); return lancar(false); })()]);
    assert.equal(a.runId, b.runId);
    assert.equal(a.messageId, b.messageId);
    assert.deepEqual([a.replay, b.replay].sort(), [false, true]);
    const [[{ runs }]] = await admin.query('SELECT count(*)::int AS runs FROM marketing.automation_runs WHERE automation_version_id = :v', { replacements: { v: versionId } });
    const [[{ msgs }]] = await admin.query('SELECT count(*)::int AS msgs FROM crm.messages WHERE action_key = :k', { replacements: { k: actionKey } });
    assert.equal(runs, 1);
    assert.equal(msgs, 1);
  } finally {
    if (actionKey) {
      await admin.query(`DELETE FROM integration.outbox_events WHERE aggregate_id IN (SELECT id FROM crm.messages WHERE action_key = :k)`, { replacements: { k: actionKey } }).catch(() => {});
      await admin.query('DELETE FROM crm.messages WHERE action_key = :k', { replacements: { k: actionKey } }).catch(() => {});
    }
    if (versionId) await admin.query('DELETE FROM marketing.automation_runs WHERE automation_version_id = :v', { replacements: { v: versionId } }).catch(() => {});
    if (versionId) await admin.query('DELETE FROM marketing.automation_versions WHERE id = :v', { replacements: { v: versionId } }).catch(() => {});
    if (flowId) await admin.query('DELETE FROM marketing.automation_flows WHERE id = :f', { replacements: { f: flowId } }).catch(() => {});
    await admin.close();
  }
});
