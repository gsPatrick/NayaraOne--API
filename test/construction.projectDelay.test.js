'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const { detectDelayedProjects } = require('../src/engines/jobs/projectDelayDetectionJob');
const { OutboxEvent, Notification } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

// M6-74: obra com endsAtPlanned no passado e status não-terminal deve gerar project.delay.detected.
test('M6-74: projectDelayDetectionJob detecta obra atrasada e publica project.delay.detected', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const past = new Date();
    past.setDate(past.getDate() - 5);

    const project = await projectsService.createProject(
      withTenant({ name: 'Obra atrasada M6-74', managerUserId: tenant.userId, endsAtPlanned: past.toISOString() }),
      tenant.userId,
      transaction
    );

    const result = await detectDelayedProjects(transaction, new Date());
    assert.ok(result.detected >= 1);

    const events = await OutboxEvent.findAll({
      where: { aggregateId: project.id, eventType: 'project.delay.detected' },
      transaction,
    });
    assert.equal(events.length, 1);
  });
});

// GAP CORRIGIDO (fechamento de gaps pós-Marco 6, item 4): a seção 11 "Eventos mínimos" do
// Anexo I exige o nome canônico `project.created` (sem prefixo) — o código publicava
// `construction.project.created`. Confirma o nome exato publicado na Outbox na criação da obra.
test('item 4: createProject publica o evento com o nome exato "project.created" (sem prefixo "construction.")', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: 'Obra para checar nome do evento item 4' }),
      tenant.userId,
      transaction
    );

    const event = await OutboxEvent.findOne({
      where: { aggregateId: project.id, eventType: 'project.created' },
      transaction,
    });
    assert.ok(event, 'esperava um evento "project.created" na Outbox, nome exigido pelo contrato (seção 11 "Eventos mínimos")');

    const oldNameEvent = await OutboxEvent.findOne({
      where: { aggregateId: project.id, eventType: 'construction.project.created' },
      transaction,
    });
    assert.equal(oldNameEvent, null, 'não deve mais publicar o nome antigo "construction.project.created"');
  });
});

// Bug real corrigido nesta auditoria (rodada 15, 2026-10-05): project.delay.detected só ia pro
// outbox (integração externa) — ninguém dentro do app era avisado da obra atrasada. Mesma
// lacuna já corrigida em R7/R9/R10 pra outros jobs.
test('M6-74: projectDelayDetectionJob cria Notification real pro responsável, e não duplica no mesmo dia', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const past = new Date();
    past.setDate(past.getDate() - 5);

    const project = await projectsService.createProject(
      withTenant({ name: 'Obra atrasada com responsável', responsibleUserId: tenant.userId, endsAtPlanned: past.toISOString() }),
      tenant.userId,
      transaction
    );

    const first = await detectDelayedProjects(transaction, new Date());
    assert.equal(first.notified, 1);

    const notification = await Notification.findOne({
      where: { userId: tenant.userId, title: 'Obra atrasada' },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(notification, 'precisa existir uma Notification real, não só o evento de outbox');

    const second = await detectDelayedProjects(transaction, new Date());
    assert.equal(second.notified, 0, 'rodar o job de novo no mesmo dia não pode duplicar a notificação');
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 20, Frente A, 09/10/2026): o bloco de
// notificação rodava direto na transação externa, SEM savepoint próprio — diferente do bloco
// de publicação do evento (já isolado). Se Notification.create falhasse pra UMA obra, o
// Postgres abortava a transação inteira da empresa, desfazendo os eventos já publicados via
// savepoint das obras ANTERIORES do mesmo lote. Agora evento+notificação da MESMA obra
// compartilham um savepoint único — confirma que uma obra com falha na notificação não desfaz
// o evento já publicado das obras processadas antes dela no mesmo lote.
test('M6-74: uma obra com falha simulada na notificação não desfaz o evento já publicado de obras anteriores do mesmo lote (savepoint por obra)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const past = new Date();
    past.setDate(past.getDate() - 5);

    // Project.findAll (candidates) não garante ordem sem ORDER BY explícito — o teste não pode
    // depender de qual das duas obras é processada primeiro. healthyProject não tem
    // responsibleUserId (não aciona a dedupe de notificação por userId+title em nenhuma ordem);
    // só o evento (savepoint) importa pra ela. brokenProject sempre tenta notificar e sempre
    // falha, independente da ordem de varredura.
    const brokenProject = await projectsService.createProject(
      withTenant({ name: 'Obra atrasada com notificação quebrada', responsibleUserId: tenant.userId, endsAtPlanned: past.toISOString() }),
      tenant.userId,
      transaction
    );
    const healthyProject = await projectsService.createProject(
      withTenant({ name: 'Obra atrasada saudável', endsAtPlanned: past.toISOString() }),
      tenant.userId,
      transaction
    );

    const originalCreate = Notification.create.bind(Notification);
    Notification.create = async (values, options) => {
      if (values.userId === tenant.userId && values.body && values.body.includes(brokenProject.name)) {
        throw new Error('Falha simulada no Notification.create para esta obra específica.');
      }
      return originalCreate(values, options);
    };

    let result;
    try {
      result = await detectDelayedProjects(transaction, new Date());
    } finally {
      Notification.create = originalCreate;
    }

    assert.ok(result.detected >= 1, 'a obra saudável precisa ter tido o evento publicado mesmo com a outra obra falhando na notificação');

    const healthyEvents = await OutboxEvent.findAll({
      where: { aggregateId: healthyProject.id, eventType: 'project.delay.detected' },
      transaction,
    });
    assert.equal(healthyEvents.length, 1, 'o evento da obra saudável não pode ter sido desfeito pela falha da outra obra');

    const brokenEvents = await OutboxEvent.findAll({
      where: { aggregateId: brokenProject.id, eventType: 'project.delay.detected' },
      transaction,
    });
    assert.equal(brokenEvents.length, 0, 'a obra com falha na notificação não deve ter conseguido publicar o evento (savepoint revertido, erro isolado)');
  });
});

test('M6-74: obra com prazo no futuro não gera evento de atraso', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const future = new Date();
    future.setDate(future.getDate() + 30);

    const project = await projectsService.createProject(
      withTenant({ name: 'Obra no prazo M6-74', managerUserId: tenant.userId, endsAtPlanned: future.toISOString() }),
      tenant.userId,
      transaction
    );

    await detectDelayedProjects(transaction, new Date());

    const events = await OutboxEvent.findAll({
      where: { aggregateId: project.id, eventType: 'project.delay.detected' },
      transaction,
    });
    assert.equal(events.length, 0);
  });
});
