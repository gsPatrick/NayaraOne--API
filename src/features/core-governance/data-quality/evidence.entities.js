'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { ENTITY_TYPES } = require('./evidence.constants');

/**
 * Monta o `entity` do guard de evidência (M9-D807) a partir do registro de cada módulo, com os valores de hoje (`current`) e as famílias da
 * lista de campos críticos que valem para ele. Fornecedor é uma pessoa com o papel SUPPLIER ativo: a pessoa fornecedora vale para PERSON
 * e SUPPLIER, e a conta bancária dela segue SUPPLIER.
 */
async function isSupplier(personId, transaction) {
  if (!personId) return false;
  const rows = await sequelize.query(
    `SELECT 1 FROM people.person_roles WHERE person_id = :personId AND role_code = 'SUPPLIER' AND deleted_at IS NULL
        AND (ends_at IS NULL OR ends_at > now()) LIMIT 1`,
    { type: QueryTypes.SELECT, transaction, replacements: { personId } }
  );
  return rows.length > 0;
}

const base = (type, id, record, current, families) => ({ type, id, groupId: record.groupId, companyId: record.companyId, current, families });

async function personEntity(person, current, transaction) {
  const families = (await isSupplier(person.id, transaction)) ? ['PERSON', 'SUPPLIER'] : ['PERSON'];
  return base(ENTITY_TYPES.PERSON, person.id, person, current, families);
}

const propertyEntity = (property, current) => base(ENTITY_TYPES.PROPERTY, property.id, property, current, ['PROPERTY']);

/** Conta bancária: a família é a do dono (fornecedor ou pessoa); `ownerPersonId` é lido da conta antes da alteração. */
async function bankAccountEntity(account, current, transaction) {
  const family = (await isSupplier(current.ownerPersonId, transaction)) ? 'SUPPLIER' : 'PERSON';
  return base(ENTITY_TYPES.BANK_ACCOUNT, account.id, account, current, [family]);
}

/** Vínculo de proprietário do imóvel: o campo crítico é `owner` (percentual, papel e vigência do vínculo). */
const propertyOwnerEntity = (owner, current) => base(ENTITY_TYPES.PROPERTY_OWNER, owner.id, owner, current, ['PROPERTY']);

const repasseEntity = (repasse, current) => base(ENTITY_TYPES.REPASSE, repasse.id, repasse, current, ['REPASSE']);

module.exports = { isSupplier, personEntity, propertyEntity, bankAccountEntity, propertyOwnerEntity, repasseEntity };
