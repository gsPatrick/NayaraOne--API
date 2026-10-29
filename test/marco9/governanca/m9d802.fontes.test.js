'use strict';

// M9-D802 — as fontes operacionais projetadas a partir da ORIGEM REAL (serviço do módulo -> outbox -> consumidor -> calendar_items).
// Banco descartável (ver m9d802.projetor.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d802Env');
const origin = require('../_helpers/m9d802Origins');
const { SOURCE_TYPES } = require('../../../src/features/core-governance/calendar/calendar.constants');
const calendarSources = require('../../../src/features/core-governance/calendar/sources');
const { mapSourceEvent, EVENT_MAPPERS } = calendarSources;
const { isValidDeepLink } = require('../../../src/features/core-governance/calendar/calendar.deeplinks');

require('../../../src/features/core-governance'); // carrega o módulo como em produção: registra o projetor no outbox
let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const T = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(T(), fn);

/** Entrega os eventos pendentes ao projetor (pelos consumidores registrados) e devolve o item da origem. */
async function seen(sourceType, sourceId, tx) {
  await env.drain(T(), tx);
  return env.itemOf(T(), sourceType, sourceId, tx);
}
const assertLink = (item) => assert.ok(isValidDeepLink(item.deep_link) && item.deep_link.length > 1, `deep_link válido: ${item.deep_link}`);

test('m9d802 cada uma das 10 fontes tem evento de UPSERT e de fechamento mapeado', () => {
  const table = {
    CRM_TASK: { up: ['crm.task.created', 'crm.task.updated'], close: ['crm.task.completed', 'crm.task.cancelled'], reopen: ['crm.task.reopened'] },
    VISIT: { up: ['crm.visit.scheduled', 'crm.visit.rescheduled'], close: ['crm.visit.completed', 'crm.visit.cancelled'] },
    LEGAL_DEADLINE: { up: ['legal.deadline.created', 'legal.deadline.updated'], close: ['legal.deadline.completed', 'legal.deadline.cancelled'], reopen: ['legal.deadline.reopened'] },
    RENEWAL: { up: ['insurance.renewal_task.upserted', 'contract.renewal.upserted'], close: ['insurance.renewal_task.completed', 'insurance.renewal_task.cancelled', 'contract.renewal.completed', 'contract.renewal.cancelled'] },
    BILLING: { up: ['billing.schedule_item.upserted'], close: ['billing.schedule_item.paid', 'billing.schedule_item.cancelled'] },
    FISCAL: { up: ['fiscal.obligation.upserted'], close: ['fiscal.obligation.fulfilled', 'fiscal.obligation.cancelled'] },
    MAINTENANCE: { up: ['maintenance.order.scheduled', 'maintenance.order.rescheduled'], close: ['maintenance.order.completed', 'maintenance.order.cancelled'] },
    CONSTRUCTION: { up: ['project.stage.updated', 'project.created'], close: ['project.stage.completed', 'project.closed'] },
    GUARANTEE: { up: ['legal.guarantee.created', 'warranty.case.opened'], close: ['legal.guarantee.ended', 'warranty.case.closed'] },
  };
  const payload = { id: env.randomUUID(), title: 'x', dueAt: '2026-11-10T15:00:00Z', dueDate: '2026-11-10', endsAt: '2026-11-10', scheduledAt: '2026-11-10T15:00:00Z', status: 'ACTIVE' };
  for (const [source, kinds] of Object.entries(table)) {
    for (const type of [...kinds.up, ...kinds.close, ...(kinds.reopen || [])]) {
      assert.ok(EVENT_MAPPERS[type], `${source}: ${type} tem mapeador`);
    }
    for (const type of kinds.up.slice(0, 1)) {
      const out = mapSourceEvent({ id: env.randomUUID(), eventType: type, companyId: 'x', occurredAt: new Date(), payload }, { teamMap: {}, severityMap: {}, durationMin: 60 });
      assert.ok(out.items.length >= 1 || out.transitions.length >= 1, `${source}: ${type} gera item`);
    }
  }
  assert.deepEqual(SOURCE_TYPES.filter((s) => !table[s]), ['COMMITMENT'], 'COMMITMENT é projetado pelo compromisso (M9-D801, §3.1.1)');
  assert.ok(calendarSources.SOURCE_EVENT_TYPES.length >= 40);
});

test('m9d802 CRM_TASK: tarefa criada, alterada, concluída e reaberta na origem', { skip: skip() }, async () => {
  const tasks = require('../../../src/features/crm/opportunityTasks.service');
  await run(async (tx) => {
    const opp = await origin.opportunity(T(), tx);
    const task = await tasks.createOpportunityTask(opp.id, { title: 'Ligar para o cliente', dueAt: origin.future(5), assignedToUserId: T().userId }, T().userId, tx);
    let item = await seen('CRM_TASK', task.id, tx);
    assert.equal(item.status, 'OPEN'); assertLink(item);
    assert.equal(item.deep_link, `/painel/crm/tarefas/${task.id}`);
    assert.equal(item.owner_user_id, T().userId);
    await tasks.updateOpportunityTask(task.id, { dueAt: origin.future(9) }, T().userId, tx);
    const moved = await seen('CRM_TASK', task.id, tx);
    assert.ok(new Date(moved.due_at) > new Date(item.due_at), 'prazo novo projetado');
    await tasks.updateOpportunityTask(task.id, { status: 'DONE' }, T().userId, tx);
    assert.equal((await seen('CRM_TASK', task.id, tx)).status, 'DONE');
    await tasks.updateOpportunityTask(task.id, { status: 'OPEN' }, T().userId, tx);
    assert.equal((await seen('CRM_TASK', task.id, tx)).status, 'OPEN', 'reabertura explícita');
    await tasks.updateOpportunityTask(task.id, { status: 'CANCELED' }, T().userId, tx);
    assert.equal((await seen('CRM_TASK', task.id, tx)).status, 'CANCELLED');
  });
});

test('m9d802 VISIT: visita agendada, reagendada, concluída e cancelada na origem', { skip: skip() }, async () => {
  const visits = require('../../../src/features/crm/visits.service');
  await run(async (tx) => {
    const prop = await origin.property(T(), tx);
    const lead = await origin.person(T(), tx);
    const create = (extra = {}) => visits.createVisit({ groupId: T().groupId, companyId: T().companyId, propertyId: prop.id, personId: lead.id, agentUserId: T().userId, scheduledAt: origin.future(2), ...extra }, T().userId, tx);
    const visit = await create();
    let item = await seen('VISIT', visit.id, tx);
    assert.equal(item.status, 'OPEN'); assertLink(item);
    assert.equal(new Date(item.end_at) - new Date(item.due_at), 60 * 60000, 'fim = início + duração padrão');
    await visits.updateVisit(visit.id, { scheduledAt: origin.future(4) }, T().userId, tx);
    const moved = await seen('VISIT', visit.id, tx);
    assert.ok(new Date(moved.due_at) > new Date(item.due_at), 'reagendada');
    await visits.updateVisit(visit.id, { status: 'DONE' }, T().userId, tx);
    assert.equal((await seen('VISIT', visit.id, tx)).status, 'DONE');
    const other = await create();
    await seen('VISIT', other.id, tx);
    await visits.updateVisit(other.id, { status: 'CANCELED' }, T().userId, tx);
    assert.equal((await seen('VISIT', other.id, tx)).status, 'CANCELLED');
    const removed = await create();
    await seen('VISIT', removed.id, tx);
    await visits.deleteVisit(removed.id, T().userId, tx);
    assert.equal((await seen('VISIT', removed.id, tx)).status, 'CANCELLED', 'visita excluída cancela o item');
  });
});

test('m9d802 LEGAL_DEADLINE: prazo criado, alterado, concluído e reaberto pelo serviço do Jurídico', { skip: skip() }, async () => {
  const deadlines = require('../../../src/features/legal/legalDeadlines.service');
  await run(async (tx) => {
    const lc = await origin.legalCase(T(), tx);
    const deadline = await deadlines.createLegalDeadline(lc.id, { description: 'Contestação QA-M9', dueAt: origin.future(10), sourceEvent: 'teste', responsibleUserId: T().userId }, T().userId, tx);
    let item = await seen('LEGAL_DEADLINE', deadline.id, tx);
    assert.equal(item.status, 'OPEN'); assertLink(item);
    assert.equal(item.title, 'Contestação QA-M9');
    await deadlines.updateLegalDeadline(deadline.id, { dueAt: origin.future(20), changeReason: 'Prorrogação deferida' }, T().userId, tx);
    const moved = await seen('LEGAL_DEADLINE', deadline.id, tx);
    assert.ok(new Date(moved.due_at) > new Date(item.due_at));
    await deadlines.updateLegalDeadline(deadline.id, { status: 'DONE', conclusionNote: 'Protocolada' }, T().userId, tx);
    assert.equal((await seen('LEGAL_DEADLINE', deadline.id, tx)).status, 'DONE', 'conclusão na origem fecha o item');
    await deadlines.updateLegalDeadline(deadline.id, { status: 'PENDING' }, T().userId, tx);
    assert.equal((await seen('LEGAL_DEADLINE', deadline.id, tx)).status, 'OPEN');
  });
});

test('m9d802 RENEWAL (apólice): tarefa criada, concluída e cancelada na origem', { skip: skip() }, async () => {
  const renewal = require('../../../src/features/procurement/insuranceRenewal.service');
  const events = require('../../../src/features/procurement/insuranceCalendarEvents.service');
  await run(async (tx) => {
    const { policy, task } = await origin.policyWithRenewal(T(), tx);
    await events.publishRenewalUpserted(task, policy, tx);
    const item = await seen('RENEWAL', task.id, tx);
    assert.equal(item.status, 'OPEN'); assertLink(item);
    assert.equal(item.source_kind, 'INSURANCE_RENEWAL');
    assert.equal(item.deep_link, `/painel/seguros/renovacoes/${task.id}`);
    assert.equal(item.owner_user_id, T().userId, 'responsável da apólice quando a tarefa não tem');
    await renewal.completeRenewalTask(task.id, { userId: T().userId }, tx);
    assert.equal((await seen('RENEWAL', task.id, tx)).status, 'DONE');
    await assert.rejects(() => renewal.completeRenewalTask(task.id, { userId: T().userId }, tx), (e) => e.code === 'INSURANCE_RENEWAL_TASK_INVALID_STATE');
    const second = await origin.policyWithRenewal(T(), tx);
    await events.publishRenewalUpserted(second.task, second.policy, tx);
    await seen('RENEWAL', second.task.id, tx);
    await events.publishRenewalCancelled(second.task, second.policy, tx);
    assert.equal((await seen('RENEWAL', second.task.id, tx)).status, 'CANCELLED');
  });
});

test('m9d802 RENEWAL (contrato): término do contrato projetado e fechado ao encerrar', { skip: skip() }, async () => {
  const { publishContractRenewalChange } = require('../../../src/features/legal/legalDeadlineCalendarEvents.service');
  const { leaseContract } = env;
  await run(async (tx) => {
    const contract = await leaseContract(T(), tx);
    assert.equal(await publishContractRenewalChange(contract, tx), null, 'rascunho não gera item');
    contract.status = 'ACTIVE'; contract.endsAt = '2027-06-30';
    await publishContractRenewalChange(contract, tx);
    const item = await seen('RENEWAL', contract.id, tx);
    assert.equal(item.status, 'OPEN'); assertLink(item);
    assert.equal(item.source_kind, 'CONTRACT_RENEWAL');
    assert.equal(item.deep_link, `/painel/contratos/${contract.id}`);
    contract.status = 'CLOSED';
    await publishContractRenewalChange(contract, tx);
    assert.equal((await seen('RENEWAL', contract.id, tx)).status, 'DONE');
  });
});

test('m9d802 BILLING: cobrança gerada, atualizada e quitada na origem', { skip: skip() }, async () => {
  const billing = require('../../../src/features/billing/billingSchedule.service');
  await run(async (tx) => {
    const contract = await env.leaseContract(T(), tx);
    const schedule = await billing.generateBillingSchedule({ groupId: T().groupId, companyId: T().companyId, contractId: contract.id, period: '2026-12', dueDate: '2026-12-05', items: [{ componentType: 'RENT', amount: 1500 }] }, T().userId, tx);
    const item = await seen('BILLING', schedule.id, tx);
    assert.equal(item.status, 'OPEN'); assertLink(item);
    assert.equal(item.deep_link, `/painel/financeiro/cobrancas/${schedule.id}`);
    assert.equal(item.owner_user_id, null);
    assert.equal(item.owner_team, 'financeiro', 'sem responsável, vale o papel configurado');
    assert.equal(item.severity, 'WARNING', 'severidade da fonte BILLING');
    await billing.registerPayment(schedule.id, 500, T().userId, tx);
    assert.equal((await seen('BILLING', schedule.id, tx)).status, 'OPEN', 'pagamento parcial não fecha');
    await billing.registerPayment(schedule.id, 1000, T().userId, tx);
    assert.equal((await seen('BILLING', schedule.id, tx)).status, 'DONE', 'quitação fecha');
  });
});

test('m9d802 FISCAL: obrigação criada, com prazo corrigido e concluída na origem', { skip: skip() }, async () => {
  const fiscal = require('../../../src/features/correspondent/fiscal/obligations.service');
  await run(async (tx) => {
    const created = await fiscal.ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: 2031, dueAt: '2032-02-27' }, T().userId, T().groupId, T().companyId, tx);
    const item = await seen('FISCAL', created.id, tx);
    assert.equal(item.status, 'OPEN'); assertLink(item);
    assert.equal(item.owner_team, 'fiscal');
    assert.equal(item.severity, 'CRITICAL');
    await fiscal.updateObligationDueDate(created.id, '2032-03-05', 'Feriado local', T().userId, T().groupId, T().companyId, tx);
    const moved = await seen('FISCAL', created.id, tx);
    assert.ok(new Date(moved.due_at) > new Date(item.due_at));
    await fiscal.completeObligation(created.id, 'Entregue ao fisco', T().userId, T().groupId, T().companyId, tx);
    assert.equal((await seen('FISCAL', created.id, tx)).status, 'DONE');
  });
});

test('m9d802 MAINTENANCE: ordem agendada, reagendada e fechada na origem', { skip: skip() }, async () => {
  const maintenance = require('../../../src/features/inventory/maintenance.service');
  await run(async (tx) => {
    const equipment = await origin.asset(T(), tx);
    const order = await maintenance.openMaintenanceOrder({ groupId: T().groupId, companyId: T().companyId, assetId: equipment.id, description: 'Troca de lâmina', scheduledAt: origin.future(3) }, T().userId, tx);
    const item = await seen('MAINTENANCE', order.id, tx);
    assert.equal(item.status, 'OPEN'); assertLink(item);
    assert.equal(item.deep_link, `/painel/obras/pos-obra/ordens/${order.id}`);
    assert.equal(new Date(item.end_at) - new Date(item.due_at), 60 * 60000);
    await maintenance.rescheduleMaintenanceOrder(order.id, origin.future(6), T().groupId, T().companyId, T().userId, tx);
    const moved = await seen('MAINTENANCE', order.id, tx);
    assert.ok(new Date(moved.due_at) > new Date(item.due_at));
    await maintenance.closeMaintenanceOrder(order.id, T().groupId, T().companyId, T().userId, tx);
    assert.equal((await seen('MAINTENANCE', order.id, tx)).status, 'DONE');
  });
});

test('m9d802 COMMITMENT segue projetado pelo compromisso (M9-D801)', { skip: skip() }, async () => {
  const commitments = require('../../../src/features/core-governance/calendar/commitments.service');
  await run(async (tx) => {
    const created = await commitments.createCommitment(T(), { userId: T().userId, roles: ['ADMIN'] }, { title: 'QA-M9 reunião', startsAt: origin.future(2).toISOString() }, tx);
    const item = await env.itemOf(T(), 'COMMITMENT', created.id, tx);
    assert.equal(item.status, 'OPEN');
    assert.equal((await env.updatedEvents(item.id, tx)).length, 1, 'criação publica calendar.item.updated');
    await commitments.updateCommitment(T(), { userId: T().userId, roles: ['ADMIN'] }, created.id, { status: 'DONE' }, tx);
    assert.equal((await env.itemOf(T(), 'COMMITMENT', created.id, tx)).status, 'DONE');
    assert.equal((await env.updatedEvents(item.id, tx)).length, 2, 'mudança de status publica de novo');
  });
});
