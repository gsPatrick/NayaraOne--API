'use strict';

// Apoio dos testes M9-D808 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { randomUUID } = require('node:crypto');
const base = require('./m9d806Env');
const { adminQuery } = require('../../m9d801.helpers');
const { Property } = require('../../../src/models');

const { sequelize } = base;
const tag = () => `QA${randomUUID().replace(/-/g, '').slice(0, 10)}`;

/** `count` imóveis da empresa na cidade pedida (cidade única por chamada quando não informada), para filtrar o lote só por eles. */
async function properties(tenant, tx, count, { city = `Cidade ${tag()}`, ...fields } = {}) {
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(await base.property(tenant, tx, { city, state: 'SP', ...fields }));
  return { city, rows };
}

/** Lote por serviço: `body` no formato da API (snake_case). */
function bulkBody(city, patch, extra = {}) {
  return { entity_type: 'PROPERTY', filter: { city }, patch, reason: 'QA-M9 correção em massa do nome da cidade', ...extra };
}

const lotRows = (tenant, tx, where = 'TRUE', replacements = {}) => base.query(
  `SELECT * FROM governance.bulk_changes WHERE company_id = :companyId AND ${where} ORDER BY created_at, id`, { companyId: tenant.companyId, ...replacements }, tx
);
const itemRows = (lotId, tx) => base.query('SELECT * FROM governance.bulk_change_items WHERE bulk_change_id = :lotId ORDER BY created_at, id', { lotId }, tx);
const auditRows = (tenant, action, tx, where = 'TRUE', replacements = {}) => base.query(
  `SELECT * FROM audit.audit_log WHERE company_id = :companyId AND action = :action AND ${where} ORDER BY occurred_at, id`, { companyId: tenant.companyId, action, ...replacements }, tx
);
/** Cidade do imóvel; sem `tx` lê pelo superusuário do cluster descartável (dado já gravado por commit). */
const cityOf = async (id, tx) => (tx
  ? (await base.query('SELECT city FROM real_estate.properties WHERE id = :id', { id }, tx))[0].city
  : (await adminQuery('SELECT city FROM real_estate.properties WHERE id = $1', [id])).rows[0].city);
const key = () => `qa-m9-${randomUUID()}`;

module.exports = { ...base, Property, properties, bulkBody, lotRows, itemRows, auditRows, cityOf, key, tag, sequelize };
