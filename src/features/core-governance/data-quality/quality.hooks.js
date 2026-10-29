'use strict';

const models = require('../../../models');
const { markForQuality } = require('./quality.pending');

/**
 * Hooks que anotam o cadastro tocado para a avaliação de qualidade (M9-D806 §3.3). Cada modelo diz qual cadastro afeta: a pessoa (PERSON e, se for
 * fornecedora, SUPPLIER), o fornecedor (conta bancária e qualificação) ou o imóvel. A avaliação em si roda no fim da transação (quality.pending.js).
 */
const PERSON = ['PERSON', 'SUPPLIER'];
const WATCHED = [
  ['Person', (row) => [row.id, PERSON]], ['PersonContact', (row) => [row.personId, PERSON]], ['PersonAddress', (row) => [row.personId, PERSON]], ['PersonRole', (row) => [row.personId, PERSON]],
  ['BankAccount', (row) => [row.ownerPersonId, ['SUPPLIER']]], ['SupplierQualification', (row) => [row.supplierPersonId, ['SUPPLIER']]],
  ['Property', (row) => [row.id, ['PROPERTY']]], ['PropertyOwner', (row) => [row.propertyId, ['PROPERTY']]], ['PropertyOffer', (row) => [row.propertyId, ['PROPERTY']]],
  ['PropertyMedia', (row) => [row.propertyId, ['PROPERTY']]],
];
const HOOK_NAME = 'dataQualityPending';
let installed = false;

function installQualityHooks() {
  if (installed) return;
  installed = true;
  for (const [modelName, target] of WATCHED) {
    const model = models[modelName];
    if (!model) continue;
    const handler = (instance, options) => {
      const [entityId, types] = target(instance);
      types.forEach((type) => markForQuality(options && options.transaction, instance, type, entityId, instance.updatedBy));
    };
    model.addHook('afterSave', HOOK_NAME, handler);
    model.addHook('afterUpdate', HOOK_NAME, handler);
    model.addHook('afterDestroy', HOOK_NAME, handler);
  }
}

module.exports = { installQualityHooks, WATCHED };
