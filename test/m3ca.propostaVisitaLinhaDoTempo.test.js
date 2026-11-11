'use strict';

// Correções do Marco 3, pelo serviço real e com rollback:
//  - M3-13 (contrato: "visitas e propostas ligadas à oportunidade e ao imóvel"): proposta sem imóvel e visita sem oportunidade
//    são recusadas;
//  - M3-19 / Guia §10 occurredAt: a interação entra na linha do tempo pela data em que o contato aconteceu.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const proposalsService = require('../src/features/crm/proposals.service');
const visitsService = require('../src/features/crm/visits.service');
const messagesService = require('../src/features/crm/messages.service');
const opportunityTasksService = require('../src/features/crm/opportunityTasks.service');
const timelineService = require('../src/features/crm/opportunityTimeline.service');
const { createOpportunity, createTestProperty } = require('./helpers/m3caCrm');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codeOf = async (promise) => {
  try {
    await promise;
    return 'SEM_ERRO';
  } catch (err) {
    return err.code || err.message;
  }
};

test('M3-13: proposta sem imóvel é recusada; sem propertyId ela herda o imóvel de interesse da oportunidade', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const semImovel = await createOpportunity(tenant, t);
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, value: 350000 };
    assert.equal(await codeOf(proposalsService.createProposal({ ...base, opportunityId: semImovel.id }, tenant.userId, t)), 'PROPOSAL_PROPERTY_REQUIRED');
    assert.equal(await codeOf(proposalsService.createProposal({ ...base, opportunityId: semImovel.id, propertyId: null }, tenant.userId, t)), 'PROPOSAL_PROPERTY_REQUIRED');

    const property = await createTestProperty(tenant, t);
    const comImovel = await createOpportunity(tenant, t, { propertyId: property.id });
    const herdada = await proposalsService.createProposal({ ...base, opportunityId: comImovel.id }, tenant.userId, t);
    assert.equal(herdada.propertyId, property.id);
    const explicita = await proposalsService.createProposal({ ...base, opportunityId: semImovel.id, propertyId: property.id }, tenant.userId, t);
    assert.equal(explicita.propertyId, property.id);
  });
});

test('M3-13: visita sem oportunidade é recusada; com a oportunidade, a pessoa vem dela', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const property = await createTestProperty(tenant, t);
    const opp = await createOpportunity(tenant, t, { propertyId: property.id });
    const quando = new Date(Date.now() + 3 * 86400000);
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, scheduledAt: quando };
    assert.equal(await codeOf(visitsService.createVisit({ ...base, personId: opp.personId }, tenant.userId, t)), 'VISIT_VALIDATION');
    const visita = await visitsService.createVisit({ ...base, opportunityId: opp.id }, tenant.userId, t);
    assert.equal(visita.opportunityId, opp.id);
    assert.equal(visita.personId, opp.personId);
  });
});

test('M3-19: interação registrada depois do fato entra na linha do tempo pela data do contato (occurredAt)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const opp = await createOpportunity(tenant, t);
    const tresDiasAtras = new Date(Date.now() - 3 * 86400000);
    const tarefa = await opportunityTasksService.createOpportunityTask(opp.id, { title: 'Enviar opções', dueAt: new Date(Date.now() + 86400000) }, tenant.userId, t);
    const ligacao = await messagesService.createMessage(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, personId: opp.personId, opportunityId: opp.id, channel: 'PHONE', direction: 'INBOUND',
        authorType: 'CLIENT', body: 'Cliente ligou pedindo imóvel com 3 quartos', occurredAt: tresDiasAtras.toISOString(),
      },
      tenant.userId,
      t
    );
    const linha = await timelineService.getOpportunityTimeline(opp.id, t, { types: ['MESSAGE', 'TASK'] });
    const item = linha.find((i) => i.id === ligacao.id);
    assert.equal(new Date(item.occurredAt).toISOString(), tresDiasAtras.toISOString(), 'a data do item é a do contato, não a da gravação');
    const ordem = linha.map((i) => i.id);
    assert.ok(ordem.indexOf(tarefa.id) < ordem.indexOf(ligacao.id), 'a tarefa criada agora vem antes (mais recente) da ligação de 3 dias atrás');
  });
});
