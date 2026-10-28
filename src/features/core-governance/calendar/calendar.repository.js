'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Leitura de governance.calendar_items. A RLS já isola a empresa; o filtro por company_id é explícito de qualquer forma.
 * `allowedSources` é a visibilidade por origem (já calculada); lista vazia = nada visível.
 * Ordenação: due_at crescente, desempate por id. "Vencido" não existe aqui (é derivado na apresentação).
 */
function buildWhere(filters, allowedSources, companyId) {
  const where = ['company_id = :companyId', 'source_type = ANY(ARRAY[:allowed]::varchar[])', 'due_at >= :from', 'date_trunc(\'second\', due_at) <= :to'];
  const replacements = { companyId, allowed: allowedSources, from: filters.from, to: filters.to };
  if (filters.sourceTypes.length) {
    where.push('source_type = ANY(ARRAY[:sourceTypes]::varchar[])');
    replacements.sourceTypes = filters.sourceTypes;
  }
  if (filters.statuses.length) {
    where.push('status = ANY(ARRAY[:statuses]::varchar[])');
    replacements.statuses = filters.statuses;
  }
  if (filters.ownerUserId) {
    where.push('owner_user_id = :ownerUserId');
    replacements.ownerUserId = filters.ownerUserId;
  }
  return { sql: where.join(' AND '), replacements };
}

async function listItems(filters, allowedSources, tenant, transaction) {
  if (!allowedSources.length) return { rows: [], total: 0 };
  const { sql, replacements } = buildWhere(filters, allowedSources, tenant.companyId);
  const [{ total }] = await sequelize.query(`SELECT count(*)::int AS total FROM governance.calendar_items WHERE ${sql}`, { type: QueryTypes.SELECT, replacements, transaction });
  const rows = await sequelize.query(
    `SELECT * FROM governance.calendar_items WHERE ${sql} ORDER BY due_at ASC, id ASC LIMIT :limit OFFSET :offset`,
    { type: QueryTypes.SELECT, transaction, replacements: { ...replacements, limit: filters.pageSize, offset: (filters.page - 1) * filters.pageSize } }
  );
  return { rows, total };
}

module.exports = { listItems };
