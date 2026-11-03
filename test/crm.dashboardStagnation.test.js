'use strict';

/**
 * Caderno Técnico, Marco 3, seção 11 ("Próxima ação e SLA"): "Gerente visualiza oportunidades
 * sem atividade e tempo parado por estágio." Gap encontrado numa verificação cética
 * (11/10/2026): o painel de CRM (dashboard.service.js) só tinha contagem por stage e motivos
 * de perda — nenhuma visão de estagnação. Este teste prova as duas métricas novas:
 * staleOpportunities (aberta + nextActionDueAt vencido) e avgTimeInStageByStageDays (tempo
 * desde a última transição de estágio, via crm.opportunity.stage_changed no outbox).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const dashboardService = require('../src/features/crm/dashboard.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('Painel CRM: oportunidade aberta com nextAction VENCIDO aparece em staleOpportunities', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead Estagnado ${suffix}` },
      tenant.userId,
      transaction
    );

    // Cria com nextAction no futuro (passa na validação de obrigatoriedade) e then a move pro
    // passado via update direto no model — simula uma tarefa que venceu depois de criada, que é
    // o cenário real (ninguém cria uma opportunity já nascendo vencida).
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
      { nextActionDueAt: new Date(Date.now() - 2 * 86400000) },
      tenant.userId,
      transaction
    );

    const dashboard = await dashboardService.getCrmDashboard({ personId: person.id }, transaction);

    assert.equal(dashboard.staleOpportunities.count, 1);
    assert.equal(dashboard.staleOpportunities.items.length, 1);
    assert.equal(dashboard.staleOpportunities.items[0].id, opportunity.id);

    assert.ok(dashboard.avgTimeInStageByStageDays.NEW, 'esperava métrica de tempo-em-estágio para NEW');
    assert.equal(dashboard.avgTimeInStageByStageDays.NEW.total, 1);
    assert.ok(dashboard.avgTimeInStageByStageDays.NEW.avgDays >= 0);
  });
});

test('Painel CRM: oportunidade com nextAction no futuro NÃO aparece em staleOpportunities', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead Em Dia ${suffix}` },
      tenant.userId,
      transaction
    );
    await opportunitiesService.createOpportunity(
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

    const dashboard = await dashboardService.getCrmDashboard({ personId: person.id }, transaction);
    assert.equal(dashboard.staleOpportunities.count, 0);
  });
});

test('Painel CRM: oportunidade FECHADA (CLOSED_WON/LOST) nunca entra em staleOpportunities mesmo com tarefa vencida', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead Fechado ${suffix}` },
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
        nextActionDueAt: new Date(Date.now() - 2 * 86400000),
      },
      tenant.userId,
      transaction
    );
    await opportunitiesService.updateOpportunity(opportunity.id, { stage: 'CLOSED_LOST', lostReason: 'PRICE_TOO_HIGH' }, tenant.userId, transaction);

    const dashboard = await dashboardService.getCrmDashboard({ personId: person.id }, transaction);
    assert.equal(dashboard.staleOpportunities.count, 0);
    assert.equal(dashboard.avgTimeInStageByStageDays.CLOSED_LOST, undefined, 'stage fechado não entra na métrica de tempo parado');
  });
});
