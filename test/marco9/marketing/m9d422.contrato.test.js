'use strict';

// M9-D422 — o contrato manda na agenda: encerramento, ocorrência aberta e opt-out cancelam o restante; evento repetido cria uma agenda; isolamento entre empresas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { createFeedbackCase } = require('../../../src/features/crm/feedbackCases.service');
const cadence = require('../_helpers/mktCadencia');

let tenant;
let tenantB;
let offVault;
before(async () => { ({ tenantA: tenant, tenantB } = await cadence.prepararTenants()); offVault = cadence.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);
const POS = ['2026-11-13', '2026-12-10', '2027-02-08', '2027-11-10'];

async function agenda(t) {
  const person = await cadence.person(t, tenant);
  await cadence.install(t, tenant, 'POS-CHAVES');
  const delivery = await cadence.delivered(t, tenant, person);
  const out = await cadence.run(t, tenant, cadence.keysEvent(tenant, person, delivery));
  return { person, delivery, runId: out.runs[0].runId };
}

const statuses = (row) => row.actions_result.map((a) => [a.status, a.error_code || a.reason || null]);

async function assertCancelledFromNinety(t, runId, reason) {
  const row = await cadence.runRow(t, runId);
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.blocked_reason, reason);
  assert.deepEqual(statuses(row).slice(0, 2), [['OK', null], ['OK', null]]);
  assert.deepEqual(statuses(row).slice(2), [['SKIPPED', reason], ['SKIPPED', reason]], 'a ação do dia e todas as posteriores');
  assert.equal(row.next_due_at, null);
  assert.deepEqual((await cadence.events(t, runId)).map((e) => e.event_type), ['automation.run.started', 'automation.run.blocked']);
}

test('contrato_encerrado_cancela_acoes_posteriores: rescindido no dia 40, o dia 90 detecta e cancela o 90 e o 365', async () => {
  await inTx(async (t) => {
    const { person, delivery, runId } = await agenda(t);
    await cadence.dueAt(t, tenant, cadence.at10(POS[0]));
    await cadence.dueAt(t, tenant, cadence.at10(POS[1]));
    await cadence.q(t, "UPDATE legal.contracts SET status = 'TERMINATED' WHERE id = :id RETURNING id", { id: delivery.contractId });
    await cadence.dueAt(t, tenant, cadence.at10(POS[2]));
    await assertCancelledFromNinety(t, runId, 'CONTRACT_NOT_ACTIVE');
    assert.equal((await cadence.messagesOf(t, person)).length, 2);
  });
});

test('ocorrencia_aberta_no_contrato_cancela_acoes_posteriores: ocorrência aberta no vencimento cancela a ação e as posteriores', async () => {
  await inTx(async (t) => {
    const { person, runId } = await agenda(t);
    await cadence.dueAt(t, tenant, cadence.at10(POS[0]));
    await cadence.dueAt(t, tenant, cadence.at10(POS[1]));
    await createFeedbackCase({ groupId: tenant.groupId, companyId: tenant.companyId, personId: person, type: 'COMPLAINT', description: 'Reclamação QA-M9 sobre o imóvel entregue.', severity: 'HIGH', assignedToUserId: tenant.userId }, tenant.userId, t);
    await cadence.dueAt(t, tenant, cadence.at10(POS[2]));
    await assertCancelledFromNinety(t, runId, 'CONTRACT_NOT_ACTIVE');
  });
});

test('ocorrencia_resolvida_nao_cancela: com a ocorrência resolvida a cadência segue', async () => {
  await inTx(async (t) => {
    const { person, runId } = await agenda(t);
    const kase = await createFeedbackCase({ groupId: tenant.groupId, companyId: tenant.companyId, personId: person, type: 'COMPLAINT', description: 'Reclamação QA-M9 já tratada.', severity: 'LOW', assignedToUserId: tenant.userId }, tenant.userId, t);
    await cadence.q(t, "UPDATE crm.feedback_cases SET status = 'RESOLVED' WHERE id = :id RETURNING id", { id: kase.id });
    await cadence.dueAt(t, tenant, cadence.at10(POS[0]));
    assert.equal((await cadence.runRow(t, runId)).actions_result[0].status, 'OK');
  });
});

test('supressao_cancela_o_restante_da_agenda: opt-out no dia 40 deixa o 90 e o 365 SKIPPED SUPPRESSED e a run BLOCKED', async () => {
  await inTx(async (t) => {
    const { person, runId } = await agenda(t);
    await cadence.dueAt(t, tenant, cadence.at10(POS[0]));
    await cadence.dueAt(t, tenant, cadence.at10(POS[1]));
    await cadence.optOut(t, tenant, person, 'EMAIL');
    const row = await cadence.runRow(t, runId);
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.blocked_reason, 'SUPPRESSED');
    assert.deepEqual(row.actions_result.slice(2).map((a) => [a.status, a.reason]), [['SKIPPED', 'SUPPRESSED'], ['SKIPPED', 'SUPPRESSED']]);
    assert.equal((await cadence.dueAt(t, tenant, cadence.at10(POS[3]))).processed, 0);
    assert.equal((await cadence.messagesOf(t, person)).length, 2);
  });
});

test('evento_repetido_cria_uma_agenda: o mesmo keys.delivered, igual ou reentregue com outro id, não recria a agenda', async () => {
  await inTx(async (t) => {
    const { person, delivery, runId } = await agenda(t);
    const again = await cadence.run(t, tenant, cadence.keysEvent(tenant, person, delivery));
    assert.equal(again.runs[0].runId, runId);
    assert.equal(again.runs[0].replay, true);
    const sameEvent = cadence.keysEvent(tenant, person, delivery, { eventId: cadence.uid() });
    await cadence.run(t, tenant, sameEvent);
    assert.equal((await cadence.run(t, tenant, sameEvent)).duplicate, true);
    assert.equal((await cadence.q(t, 'SELECT count(*)::int AS n FROM marketing.automation_runs WHERE subject_id = :p', { p: person }))[0].n, 1);
  });
});

test('o_consumidor_do_outbox_inicia_a_agenda_pelo_evento_keys_delivered: pessoa da entrega e data da entrega vêm do evento e do banco', async () => {
  await inTx(async (t) => {
    const person = await cadence.person(t, tenant);
    await cadence.install(t, tenant, 'POS-CHAVES');
    const delivery = await cadence.delivered(t, tenant, person);
    const event = { id: cadence.uid(), eventType: 'keys.delivered', aggregateType: 'KeyDelivery', aggregateId: delivery.deliveryId, groupId: tenant.groupId, companyId: tenant.companyId,
      payloadJson: { id: delivery.deliveryId, contractId: delivery.contractId, deliveredToPersonId: person } };
    assert.ok((await runEventConsumers(event, t)).includes('marketing.automation.runner'));
    const [row] = await cadence.q(t, 'SELECT id, status, actions_result FROM marketing.automation_runs WHERE subject_id = :p', { p: person });
    assert.equal(row.status, 'WAITING');
    assert.deepEqual(row.actions_result.map((a) => cadence.ISO(a.due_at)), POS.map(cadence.at10));
  });
});

test('a_agenda_e_isolada_por_empresa: a outra empresa não enxerga a run e não dispara a automação da primeira', async () => {
  await inTx(async (t) => {
    const { runId } = await agenda(t);
    const event = cadence.keysEvent(tenantB, null, { contractId: cadence.uid(), deliveryId: cadence.uid() });
    const foreign = await cadence.asTenant(t, tenant, tenantB, () => cadence.run(t, tenantB, event));
    assert.deepEqual(foreign.runs, [], 'a empresa B não tem a automação');
    const seen = await cadence.asTenant(t, tenant, tenantB, () => cadence.q(t, 'SELECT count(*)::int AS n FROM marketing.automation_runs WHERE id = :id', { id: runId }));
    assert.equal(seen[0].n, 0);
  });
});
