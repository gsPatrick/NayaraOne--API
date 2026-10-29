'use strict';

// Apoio dos testes M9-D807 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { QueryTypes } = require('sequelize');
const base = require('./m9d804Env');
const { Person, PersonRole, Property, BankAccount, File } = require('../../../src/models');

const { sequelize } = base;
const suffix = () => `${Date.now()}${Math.floor(Math.random() * 1000000)}`;

async function person(tenant, tx, fields = {}) {
  return Person.create({
    groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `QA-M9 Pessoa ${suffix()}`,
    createdBy: tenant.userId, updatedBy: tenant.userId, ...fields,
  }, { transaction: tx });
}

async function supplier(tenant, tx, fields = {}) {
  const row = await person(tenant, tx, { personType: 'PJ', ...fields });
  await PersonRole.create({ groupId: tenant.groupId, companyId: tenant.companyId, personId: row.id, roleCode: 'SUPPLIER', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: tx });
  return row;
}

async function property(tenant, tx, fields = {}) {
  return Property.create({
    groupId: tenant.groupId, companyId: tenant.companyId, title: `QA-M9 Imóvel ${suffix()}`, internalCode: `M9D807-${suffix()}`, propertyType: 'HOUSE',
    createdBy: tenant.userId, updatedBy: tenant.userId, ...fields,
  }, { transaction: tx });
}

async function bankAccount(tenant, tx, ownerPersonId, fields = {}) {
  return BankAccount.create({
    groupId: tenant.groupId, companyId: tenant.companyId, ownerPersonId, bankCode: '001', agency: '1234', accountNumber: '99887-1', pixKey: 'antiga@qa-m9.test',
    status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId, ...fields,
  }, { transaction: tx });
}

async function file(tenant, tx) {
  return File.create({
    groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `qa-m9/${suffix()}`, fileName: 'comprovante.pdf', mimeType: 'application/pdf',
    sizeBytes: 10, checksumSha256: 'a'.repeat(64), uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: tx });
}

/** Linhas de governance.field_change_evidence de uma entidade. */
async function evidenceRows(entityId, tx) {
  return sequelize.query('SELECT * FROM governance.field_change_evidence WHERE entity_id = :entityId ORDER BY field', { type: QueryTypes.SELECT, transaction: tx, replacements: { entityId } });
}

/** CPF válido aleatório (os testes que fazem commit não podem colidir com os que usam rollback no mesmo cluster). */
function cpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (new Set(base).size === 1) base[0] = (base[0] + 1) % 10;
  const digit = (list) => { const sum = list.reduce((acc, n, i) => acc + n * (list.length + 1 - i), 0) % 11; return sum < 2 ? 0 : 11 - sum; };
  const d1 = digit(base);
  return [...base, d1, digit([...base, d1])].join('');
}

const codeOf = (promise) => promise.then(() => null, (err) => err.code);

module.exports = { ...base, person, supplier, property, bankAccount, file, evidenceRows, codeOf, cpf, suffix, sequelize };
