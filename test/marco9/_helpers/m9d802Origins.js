'use strict';

// Fábricas de registros de ORIGEM reais para os testes M9-D802 (não é teste): criam pelo serviço de cada módulo, na transação do teste.
const { randomUUID } = require('node:crypto');
const { Property, Person, InsurancePolicy, InsuranceRenewalTask } = require('../../../src/models');
const peopleService = require('../../../src/features/people/people.service');
const opportunitiesService = require('../../../src/features/crm/opportunities.service');
const legalCasesService = require('../../../src/modules/legal/cases/legal-case.service');
const assetsService = require('../../../src/features/inventory/assets.service');

const sfx = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;
const future = (days) => new Date(Date.now() + days * 86400000);

async function person(t, tx) {
  return peopleService.createPerson({ groupId: t.groupId, companyId: t.companyId, personType: 'PF', legalName: `QA-M9 pessoa ${sfx()}` }, t.userId, tx);
}

async function opportunity(t, tx) {
  const owner = await person(t, tx);
  return opportunitiesService.createOpportunity({ groupId: t.groupId, companyId: t.companyId, personId: owner.id, stage: 'QUALIFYING', nextAction: 'Ligar', nextActionDueAt: future(3) }, t.userId, tx);
}

async function property(t, tx) {
  return Property.create({ groupId: t.groupId, companyId: t.companyId, title: `Imóvel QA-M9 ${sfx()}`, internalCode: `QA-M9-${sfx()}`, propertyType: 'HOUSE', createdBy: t.userId, updatedBy: t.userId }, { transaction: tx });
}

async function legalCase(t, tx) {
  return legalCasesService.createLegalCase({ groupId: t.groupId, companyId: t.companyId, caseType: 'LITIGATION', summary: `QA-M9 ${sfx()}`, responsibleUserId: t.userId }, t.userId, tx);
}

async function asset(t, tx) {
  return assetsService.createAsset({ groupId: t.groupId, companyId: t.companyId, name: `Serra QA-M9 ${sfx()}`, assetTag: `QM9-${sfx()}` }, t.userId, tx);
}

/** Apólice com tarefa de renovação PENDING (como a emissão cria), sem passar pelo fluxo de emissão. */
async function policyWithRenewal(t, tx) {
  const policy = await InsurancePolicy.create({ groupId: t.groupId, companyId: t.companyId, externalPolicyNumber: `QA-M9-${sfx()}`, status: 'ACTIVE', expiryDate: '2027-03-31', createdBy: t.userId, updatedBy: t.userId }, { transaction: tx });
  const task = await InsuranceRenewalTask.create({ groupId: t.groupId, companyId: t.companyId, policyId: policy.id, dueDate: '2027-03-01', status: 'PENDING' }, { transaction: tx });
  return { policy, task };
}

module.exports = { randomUUID, person, opportunity, property, legalCase, asset, policyWithRenewal, future, sfx, Person };
