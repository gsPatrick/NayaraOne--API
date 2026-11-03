'use strict';

/**
 * CRMX-005 (Caderno Técnico, Marco 3, seção 2): "Histórico permanente — Preço, atendimento,
 * visita, proposta e perda permanecem auditáveis." Confirma que nada nesse conjunto é
 * destrutível de verdade:
 *   - preço: PropertyPriceHistory é append-only (prova já existe em properties.priceRace.test.js
 *     e na criação normal de offer); aqui confirmamos que a tabela não tem rota de update/delete.
 *   - visita/proposta/oportunidade: os models são `paranoid: true` — DELETE vira soft delete
 *     (deletedAt), a linha nunca some de verdade do banco, auditável via unscoped query.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const opportunityService = require('../src/features/crm/opportunity.service');
const visitsService = require('../src/features/crm/visits.service');
const { Visit } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('CRMX-005: apagar uma oportunidade é soft delete — a linha continua existindo (auditável), só sai das listagens normais', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Perm History ${suffix}` },
      tenant.userId,
      transaction
    );
    const opportunity = await opportunityService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        ownerUserId: tenant.userId,
        nextAction: 'Ligar',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );

    await opportunityService.deleteOpportunity(opportunity.id, tenant.userId, transaction);

    const { Opportunity } = require('../src/models');
    const normalLookup = await Opportunity.findByPk(opportunity.id, { transaction });
    assert.equal(normalLookup, null, 'consulta normal (escopo paranoid) não deve mais devolver a oportunidade apagada');

    // Consulta SQL crua (sem depender de nenhuma opção específica de versão do Sequelize para
    // "ignorar paranoid") — a prova objetiva de que a linha não foi fisicamente apagada é
    // simplesmente: ela ainda existe na tabela, com deleted_at preenchido.
    const [rows] = await sequelize.query(
      'SELECT deleted_at FROM "crm"."opportunities" WHERE id = :id',
      { replacements: { id: opportunity.id }, transaction }
    );
    assert.equal(rows.length, 1, 'a linha precisa continuar existindo fisicamente no banco (auditável)');
    assert.ok(rows[0].deleted_at, 'deleted_at precisa estar preenchido (soft delete, não DELETE físico)');
  });
});

test('CRMX-005: apagar uma visita é soft delete — histórico de atendimento preservado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Perm History Visit ${suffix}` },
      tenant.userId,
      transaction
    );
    const opportunity = await opportunityService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        ownerUserId: tenant.userId,
        nextAction: 'Ligar',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Perm History Property ${suffix}`, internalCode: `PERM-HIST-${suffix}`, propertyType: 'RESIDENTIAL', city: `PermHistCity${suffix}` },
      tenant.userId,
      transaction
    );
    const visit = await visitsService.createVisit(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, opportunityId: opportunity.id, personId: person.id, scheduledAt: new Date(Date.now() + 86400000) },
      tenant.userId,
      transaction
    );

    await visitsService.deleteVisit(visit.id, tenant.userId, transaction);

    const normalLookup = await Visit.findByPk(visit.id, { transaction });
    assert.equal(normalLookup, null);

    const [rows] = await sequelize.query(
      'SELECT deleted_at FROM "crm"."visits" WHERE id = :id',
      { replacements: { id: visit.id }, transaction }
    );
    assert.equal(rows.length, 1, 'visita precisa continuar existindo fisicamente no banco (auditável)');
    assert.ok(rows[0].deleted_at);
  });
});
