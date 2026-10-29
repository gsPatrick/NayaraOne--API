'use strict';

/**
 * M9-D810 — nome do campo no modelo de domínio. O campo de origem é a COLUNA da tabela (`finance.financial_entries.amount`); o campo de domínio é o atributo
 * da entidade do Sequelize que a guarda (`finance.FinancialEntry.amount`). Sem modelo para a tabela, o atributo é a coluna em camelCase.
 */
let byTable = null;

function loadModels() {
  const { sequelize } = require('../../../../models');
  const map = new Map();
  for (const model of Object.values(sequelize.models)) {
    const target = model.getTableName();
    const table = typeof target === 'string' ? `public.${target}` : `${target.schema}.${target.tableName}`;
    if (!map.has(table)) map.set(table, model);
  }
  return map;
}

const camel = (column) => column.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

/** `schema.tabela.coluna` -> `schema.Entidade.atributo`. */
function domainFieldOf(qualifiedColumn) {
  const [schema, table, column] = qualifiedColumn.split('.');
  byTable = byTable || loadModels();
  const model = byTable.get(`${schema}.${table}`);
  if (!model) return `${schema}.${table}.${camel(column)}`;
  const attribute = Object.entries(model.rawAttributes).find(([name, def]) => (def.field || name) === column);
  return `${schema}.${model.name}.${attribute ? attribute[0] : camel(column)}`;
}

module.exports = { domainFieldOf };
