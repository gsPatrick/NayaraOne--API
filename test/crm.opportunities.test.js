'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const { OutboxEvent } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('opportunity ativa sem nextAction/nextActionDueAt falha com 422', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead CRM ${suffix}` },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        opportunitiesService.createOpportunity(
          { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, stage: 'NEW' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, 'OPPORTUNITY_NEXT_ACTION_REQUIRED');
        return true;
      }
    );
  });
});

test('opportunity ativa com nextAction/nextActionDueAt é criada e publica domain event de stage_changed', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead CRM OK ${suffix}` },
      tenant.userId,
      transaction
    );

    const opportunity = await opportunitiesService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        stage: 'NEW',
        nextAction: 'Ligar para o cliente',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );
    assert.ok(opportunity.id);

    const events = await OutboxEvent.findAll({ where: { aggregateId: opportunity.id }, transaction });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'crm.opportunity.stage_changed');
  });
});

test('opportunity fechada (CLOSED_WON/CLOSED_LOST) não exige nextAction', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead CRM Fechado ${suffix}` },
      tenant.userId,
      transaction
    );

    const opportunity = await opportunitiesService.createOpportunity(
      { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, stage: 'CLOSED_LOST', lostReason: 'Sem orçamento' },
      tenant.userId,
      transaction
    );
    assert.equal(opportunity.stage, 'CLOSED_LOST');
    assert.ok(opportunity.closedAt);
  });
});

test('atualizar stage de opportunity publica novo domain event de stage_changed', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead CRM Stage ${suffix}` },
      tenant.userId,
      transaction
    );

    const opportunity = await opportunitiesService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        stage: 'NEW',
        nextAction: 'Ligar para o cliente',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );

    await opportunitiesService.updateOpportunity(
      opportunity.id,
      { stage: 'QUALIFIED', nextAction: 'Agendar visita', nextActionDueAt: new Date(Date.now() + 2 * 86400000) },
      tenant.userId,
      transaction
    );

    const events = await OutboxEvent.findAll({
      where: { aggregateId: opportunity.id },
      order: [['occurred_at', 'ASC']],
      transaction,
    });
    assert.equal(events.length, 2);
    assert.equal(events[1].payloadJson.fromStage, 'NEW');
    assert.equal(events[1].payloadJson.toStage, 'QUALIFIED');
  });
});
