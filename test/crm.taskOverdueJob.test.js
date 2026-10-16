'use strict';

// Item 5 do ciclo de auditoria externa (Marco 3). Contrato bruto:
//   Guia do Marcelo §11 ("Próxima ação e SLA"): "Tarefa vencida escala conforme regra."
//   Caderno Pessoas/Imóveis/CRM/Radar §17 ("Eventos mínimos"): lista `crm.task.overdue`.
// Mesmo padrão estrutural de legalDeadlineAlertJob.js / feedbackCaseAlertJob.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Task, OutboxEvent, AuditLog, Notification } = require('../src/models');
const opportunitiesService = require('../src/features/crm/opportunity.service');
const peopleService = require('../src/features/people/person.service');
const { escalateOverdueCrmTasks } = require('../src/engines/jobs/crmTaskOverdueJob');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('crmTaskOverdueJob escalona tarefa de CRM vencida: publica crm.task.overdue, notifica e audita (idempotente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();

    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead Overdue ${suffix}` },
      tenant.userId,
      transaction
    );

    const opportunity = await opportunitiesService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        stage: 'NEW',
        ownerUserId: tenant.userId,
        nextAction: 'Ligar para o cliente',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );

    const past = new Date(Date.now() - 2 * 86400000);
    const overdueTask = await Task.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        assignedToUserId: tenant.userId,
        title: `Tarefa vencida ${suffix}`,
        relatedEntityType: 'crm.opportunities',
        relatedEntityId: opportunity.id,
        dueAt: past,
        status: 'OPEN',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    const futureTask = await Task.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        assignedToUserId: tenant.userId,
        title: `Tarefa futura ${suffix}`,
        relatedEntityType: 'crm.opportunities',
        relatedEntityId: opportunity.id,
        dueAt: new Date(Date.now() + 86400000),
        status: 'OPEN',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    // Nota: o banco de desenvolvimento compartilhado pode ter outras tarefas de CRM vencidas
    // de execuções anteriores (fora da transação de rollback deste teste) — por isso não
    // fixamos `result.escalated === 1`, e sim verificamos abaixo, por id, que ESTA tarefa
    // vencida foi escalonada e a tarefa futura não foi.
    const result = await escalateOverdueCrmTasks(transaction, new Date());
    assert.ok(result.escalated >= 1, 'ao menos a tarefa vencida criada neste teste deveria ser escalonada');

    const event = await OutboxEvent.findOne({
      where: { eventType: 'crm.task.overdue', aggregateId: overdueTask.id },
      transaction,
    });
    assert.ok(event, 'evento crm.task.overdue precisa ter sido publicado no outbox');

    const auditEntry = await AuditLog.findOne({
      where: { action: 'crm.task.job_escalation', entityId: overdueTask.id },
      transaction,
    });
    assert.ok(auditEntry, 'auditoria do escalonamento automático precisa existir');

    const notification = await Notification.findOne({
      where: { userId: tenant.userId, title: 'Tarefa de CRM vencida' },
      transaction,
      order: [['created_at', 'DESC']],
    });
    assert.ok(notification, 'responsável pela tarefa precisa ser notificado');

    const noEventForFuture = await OutboxEvent.findOne({
      where: { eventType: 'crm.task.overdue', aggregateId: futureTask.id },
      transaction,
    });
    assert.equal(noEventForFuture, null, 'tarefa ainda não vencida não deve gerar crm.task.overdue');

    // Idempotência: rodar o job de novo não duplica o escalonamento da MESMA tarefa — garantido
    // contando quantas linhas de auditoria 'crm.task.job_escalation' existem para overdueTask.id
    // antes/depois da segunda rodada (precisa continuar exatamente 1).
    await escalateOverdueCrmTasks(transaction, new Date());
    const auditCountAfterSecondRun = await AuditLog.count({
      where: { action: 'crm.task.job_escalation', entityId: overdueTask.id },
      transaction,
    });
    assert.equal(auditCountAfterSecondRun, 1, 'tarefa já escalonada não deve gerar uma segunda auditoria/evento na próxima rodada');
  });
});
