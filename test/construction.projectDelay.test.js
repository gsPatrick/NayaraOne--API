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
