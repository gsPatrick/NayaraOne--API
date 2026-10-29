'use strict';

const { sequelize } = require('../../../models');
const { hashTaxId } = require('../../people/personDocumentFormat.service');
const evidence = require('./evidence');
const { comparable } = require('./evidence.criticalFields');
const errors = require('./merge.errors');

/** Campos críticos (nome na API -> coluna) que cada tipo de cadastro tem na própria linha. */
const COLUMNS = Object.freeze({
  PERSON: { legalName: 'legal_name', taxIdNormalized: 'tax_id_normalized', birthOrFoundationDate: 'birth_or_foundation_date' },
  PROPERTY: { registryNumber: 'registry_number' },
});
const columnsOf = (entityType) => COLUMNS[entityType === 'SUPPLIER' ? 'PERSON' : entityType];
const families = (entityType) => (entityType === 'SUPPLIER' ? ['PERSON', 'SUPPLIER'] : [entityType]);
const valueOf = (row, column) => (row[column] === undefined ? null : row[column]);

/**
 * Campos críticos (lista de M9-D807) em que os dois cadastros têm valor diferente. Dois valores preenchidos e diferentes de CPF/CNPJ ou de
 * matrícula continuam sendo o bloqueio dos serviços de união (identidades distintas), por isso não entram como escolha.
 */
async function findConflicts(entityType, survivor, other, tenant, transaction) {
  const critical = new Set((await evidence.criticalFieldsFor(tenant, transaction)).filter((item) => families(entityType).includes(item.split('.')[0])).map((item) => item.split('.')[1]));
  const hardBlock = ['taxIdNormalized', 'registryNumber'];
  return Object.entries(columnsOf(entityType)).filter(([field, column]) => {
    if (!critical.has(field)) return false;
    const [a, b] = [comparable(valueOf(survivor, column)), comparable(valueOf(other, column))];
    if (a === b) return false;
    return !(hardBlock.includes(field) && a !== null && b !== null);
  }).map(([field, column]) => ({ field, column, survivor: valueOf(survivor, column), other: valueOf(other, column) }));
}

/**
 * Resolve os conflitos com a escolha explícita do steward (fieldChoices) e passa pelo guard de evidência da M9-D807: escolher o valor do outro
 * cadastro muda um campo crítico do sobrevivente e exige changeEvidence. Devolve { applyChoices, record, choices }: gravar é depois do guard.
 */
async function resolveConflicts(entityType, survivor, other, input, ctx) {
  const conflicts = await findConflicts(entityType, survivor, other, ctx.tenant, ctx.transaction);
  const missing = conflicts.filter((c) => !input.fieldChoices[c.field]).map((c) => c.field);
  if (missing.length) throw errors.conflictUnresolved(missing);
  const taken = conflicts.filter((c) => input.fieldChoices[c.field] === 'OTHER');
  const entity = {
    type: entityType === 'PROPERTY' ? 'PROPERTY' : 'PERSON', id: survivor.id, groupId: survivor.group_id, companyId: survivor.company_id,
    families: families(entityType), current: Object.fromEntries(conflicts.map((c) => [c.field, c.survivor])),
  };
  const assertion = await evidence.assertEvidenceForCriticalChange(entity, Object.fromEntries(taken.map((c) => [c.field, c.other])), input.evidence, { transaction: ctx.transaction, actorUserId: ctx.actorUserId });
  const choices = Object.fromEntries(conflicts.map((c) => [c.field, input.fieldChoices[c.field]]));
  return {
    choices,
    assertion,
    async apply() {
      const table = entityType === 'PROPERTY' ? 'real_estate.properties' : 'people.persons';
      for (const c of taken) {
        if (c.field === 'taxIdNormalized') {
          await sequelize.query('UPDATE people.persons SET tax_id_normalized = NULL, tax_id_normalized_hash = NULL WHERE id = :id', { transaction: ctx.transaction, replacements: { id: other.id } });
          await sequelize.query('UPDATE people.persons SET tax_id_normalized = :value, tax_id_normalized_hash = :hash WHERE id = :id', { transaction: ctx.transaction, replacements: { id: survivor.id, value: c.other, hash: hashTaxId(c.other) } });
        } else {
          if (c.field === 'registryNumber') await sequelize.query('UPDATE real_estate.properties SET registry_number = NULL WHERE id = :id', { transaction: ctx.transaction, replacements: { id: other.id } });
          await sequelize.query(`UPDATE ${table} SET ${c.column} = :value WHERE id = :id`, { transaction: ctx.transaction, replacements: { id: survivor.id, value: c.other } });
        }
      }
      await evidence.recordFieldChangeEvidence(entity, assertion, { transaction: ctx.transaction, actorUserId: ctx.actorUserId });
    },
  };
}

module.exports = { findConflicts, resolveConflicts };
