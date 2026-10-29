'use strict';

const { Op, literal } = require('sequelize');
const { sequelize, Person, Property } = require('../../../models');

const MODEL_OF = { PERSON: Person, SUPPLIER: Person, PROPERTY: Property };
const NULL_CHECK = { true: { [Op.is]: null }, false: { [Op.not]: null } };

/**
 * Condição do lote (M9-D808 §3.1): sempre limitada à empresa do autor e aos cadastros vivos e não unidos; os campos vêm da lista fechada de
 * bulk.fields.js e os valores entram como parâmetro do ORM. Fornecedor = pessoa com o papel SUPPLIER vigente.
 */
function whereOf(tenant, entityType, filter) {
  const where = { companyId: tenant.companyId, mergedIntoId: null };
  if (filter.ids) where.id = { [Op.in]: filter.ids };
  for (const [name, criterion] of Object.entries(filter.fields)) {
    if (criterion.op === 'eq') where[name] = criterion.value;
    else if (criterion.op === 'in') where[name] = { [Op.in]: criterion.value };
    else where[name] = NULL_CHECK[criterion.value];
  }
  if (entityType === 'SUPPLIER') {
    where[Op.and] = [literal(`id IN (SELECT person_id FROM people.person_roles WHERE role_code = 'SUPPLIER' AND deleted_at IS NULL AND (ends_at IS NULL OR ends_at > now()) AND company_id = ${sequelize.escape(tenant.companyId)})`)];
  }
  return where;
}

const countMatches = (tenant, entityType, filter, transaction) => MODEL_OF[entityType].count({ where: whereOf(tenant, entityType, filter), transaction });

/** Os cadastros do lote em ordem de id (sem deadlock entre lotes); `lock` trava FOR UPDATE até o fim da transação. */
function loadMatches(tenant, entityType, filter, { transaction, lock }) {
  return MODEL_OF[entityType].findAll({ where: whereOf(tenant, entityType, filter), order: [['id', 'ASC']], transaction, lock: lock ? transaction.LOCK.UPDATE : undefined });
}

module.exports = { countMatches, loadMatches };
