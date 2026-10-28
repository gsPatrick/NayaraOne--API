'use strict';

// Apoio dos testes M9-D803 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { Property, OutboxEvent } = require('../../../src/models');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { DISPOSABLE, SKIP_DISPOSABLE, loadTenants } = require('../../m9d801.helpers');
const contractsService = require('../../../src/features/legal/contracts.service');

const suffix = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function property(tenant, transaction) {
  return Property.create({
    groupId: tenant.groupId, companyId: tenant.companyId, title: `Imóvel M9D803 ${suffix()}`, internalCode: `M9D803-${suffix()}`,
    propertyType: 'HOUSE', createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction });
}

async function leaseContract(tenant, transaction) {
  return contractsService.createContract({ groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1500 }, tenant.userId, transaction);
}

/** Eventos do outbox de um agregado, do mais antigo ao mais novo. */
async function events(aggregateId, eventType, transaction) {
  return OutboxEvent.findAll({ where: { aggregateId, eventType }, order: [['created_at', 'ASC']], transaction });
}

module.exports = { DISPOSABLE, SKIP_DISPOSABLE, loadTenants, withRollbackTenantTransaction, property, leaseContract, events, sequelize };
