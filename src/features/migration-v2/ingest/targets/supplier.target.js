'use strict';

const { PersonRole } = require('../../../../models');
const person = require('./person.target');

/** Destino SUPPLIER: fornecedor é pessoa com o papel SUPPLIER (mesmos campos canônicos de PERSON). */
async function upsert(tenant, actor, row, existingTargetId, transaction) {
  const id = await person.upsert(tenant, actor, row, existingTargetId, transaction);
  await PersonRole.findOrCreate({
    where: { companyId: tenant.companyId, personId: id, roleCode: 'SUPPLIER' },
    defaults: { groupId: tenant.groupId, createdBy: actor.userId || null, updatedBy: actor.userId || null }, transaction,
  });
  return id;
}

module.exports = { entityType: 'SUPPLIER', assess: person.assess, upsert, markDeleted: person.markDeleted };
