'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Carrega, em lote, o contexto de cada cadastro que as verificações de quality.checks.js leem (M9-D806 §3.1). Cadastro apagado ou já unido a outro
 * (merged_into_id) não entra: não há o que avaliar. Fornecedor = pessoa com o papel SUPPLIER vigente. Datas voltam como texto AAAA-MM-DD.
 */
const q = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const countBy = (rows, key) => new Map(rows.map((row) => [row[key], row.n]));
const ACTIVE_ROLE = '(ends_at IS NULL OR ends_at > now()) AND (starts_at IS NULL OR starts_at <= now())';

async function personRows(tenant, ids, supplierOnly, transaction) {
  const supplier = supplierOnly ? `AND EXISTS (SELECT 1 FROM people.person_roles r WHERE r.person_id = p.id AND r.role_code = 'SUPPLIER' AND r.deleted_at IS NULL AND ${ACTIVE_ROLE})` : '';
  return q(`SELECT p.id, p.person_type, p.legal_name, p.tax_id_normalized, p.birth_or_foundation_date::text AS birth_or_foundation_date, p.risk_flags_json
              FROM people.persons p WHERE p.id IN (:ids) AND p.company_id = :companyId AND p.deleted_at IS NULL AND p.merged_into_id IS NULL ${supplier}`, { ids, companyId: tenant.companyId }, transaction);
}

async function contactCounts(ids, transaction) {
  return countBy(await q('SELECT person_id, count(*)::int AS n FROM people.person_contacts WHERE person_id IN (:ids) AND deleted_at IS NULL GROUP BY person_id', { ids }, transaction), 'person_id');
}

async function loadPeople(tenant, entityType, ids, transaction) {
  const people = await personRows(tenant, ids, entityType === 'SUPPLIER', transaction);
  if (!people.length) return new Map();
  const found = people.map((p) => p.id);
  const contacts = await contactCounts(found, transaction);
  const addresses = new Map((await q(
    `SELECT DISTINCT ON (person_id) person_id, zip_code, street, number, neighborhood, city, state FROM people.person_addresses
      WHERE person_id IN (:ids) AND is_current AND (valid_until IS NULL OR valid_until >= CURRENT_DATE) ORDER BY person_id, updated_at DESC`, { ids: found }, transaction
  )).map((row) => [row.person_id, row]));
  const roles = countBy(await q(`SELECT person_id, count(*)::int AS n FROM people.person_roles WHERE person_id IN (:ids) AND deleted_at IS NULL AND ${ACTIVE_ROLE} GROUP BY person_id`, { ids: found }, transaction), 'person_id');
  const banks = countBy(await q("SELECT owner_person_id AS person_id, count(*)::int AS n FROM finance.bank_accounts WHERE owner_person_id IN (:ids) AND deleted_at IS NULL AND status = 'ACTIVE' GROUP BY owner_person_id", { ids: found }, transaction), 'person_id');
  const qualifications = new Map((await q(
    `SELECT DISTINCT ON (s.supplier_person_id) s.supplier_person_id, s.valid_until::text AS valid_until, s.high_risk, s.due_diligence_status,
            (SELECT count(*)::int FROM jsonb_array_elements_text(s.document_file_ids) e JOIN people.files f ON f.id = e.value::uuid AND f.deleted_at IS NULL) AS document_count
       FROM procurement.supplier_qualifications s WHERE s.supplier_person_id IN (:ids) AND s.deleted_at IS NULL ORDER BY s.supplier_person_id, s.updated_at DESC`, { ids: found }, transaction
  )).map((row) => [row.supplier_person_id, row]));
  return new Map(people.map((person) => [person.id, {
    person, contacts: contacts.get(person.id) || 0, address: addresses.get(person.id) || null, roles: roles.get(person.id) || 0, banks: banks.get(person.id) || 0,
    qualification: qualifications.get(person.id) || null, category: person.risk_flags_json && person.risk_flags_json.category ? String(person.risk_flags_json.category) : null,
  }]));
}

async function loadProperties(tenant, ids, transaction) {
  const properties = await q(
    `SELECT p.id, p.registry_number, p.area_total_m2, p.address_id, p.address_line, p.city, p.state, p.zip_code FROM real_estate.properties p
      WHERE p.id IN (:ids) AND p.company_id = :companyId AND p.deleted_at IS NULL AND p.merged_into_id IS NULL`, { ids, companyId: tenant.companyId }, transaction
  );
  if (!properties.length) return new Map();
  const found = properties.map((p) => p.id);
  const addressIds = properties.map((p) => p.address_id).filter(Boolean);
  const shared = new Map(addressIds.length ? (await q('SELECT id, zip_code, street, number, neighborhood, city, state FROM real_estate.property_addresses WHERE id IN (:ids)', { ids: addressIds }, transaction)).map((a) => [a.id, a]) : []);
  const owners = countBy(await q('SELECT property_id, count(*)::int AS n FROM real_estate.property_owners WHERE property_id IN (:ids) AND deleted_at IS NULL AND (valid_until IS NULL OR valid_until >= CURRENT_DATE) GROUP BY property_id', { ids: found }, transaction), 'property_id');
  const offers = countBy(await q("SELECT property_id, count(*)::int AS n FROM real_estate.property_offers WHERE property_id IN (:ids) AND deleted_at IS NULL AND status = 'ACTIVE' GROUP BY property_id", { ids: found }, transaction), 'property_id');
  const media = countBy(await q('SELECT property_id, count(*)::int AS n FROM real_estate.property_media WHERE property_id IN (:ids) GROUP BY property_id', { ids: found }, transaction), 'property_id');
  return new Map(properties.map((property) => [property.id, {
    property, address: shared.get(property.address_id) || (property.address_line ? { zip_code: property.zip_code, street: property.address_line, city: property.city, state: property.state } : null),
    owners: owners.get(property.id) || 0, offers: offers.get(property.id) || 0, media: media.get(property.id) || 0,
  }]));
}

/** Map id -> contexto, só para os cadastros vivos da empresa. */
async function loadContexts(tenant, entityType, ids, transaction) {
  if (!ids.length) return new Map();
  return entityType === 'PROPERTY' ? loadProperties(tenant, ids, transaction) : loadPeople(tenant, entityType, ids, transaction);
}

/** Ids dos cadastros vivos da empresa depois de `afterId` (varredura por páginas de id). */
async function listLiveIds(tenant, entityType, afterId, limit, transaction) {
  const table = entityType === 'PROPERTY' ? 'real_estate.properties' : 'people.persons';
  const supplier = entityType === 'SUPPLIER' ? `AND EXISTS (SELECT 1 FROM people.person_roles r WHERE r.person_id = t.id AND r.role_code = 'SUPPLIER' AND r.deleted_at IS NULL AND ${ACTIVE_ROLE})` : '';
  const rows = await q(
    `SELECT t.id FROM ${table} t WHERE t.company_id = :companyId AND t.deleted_at IS NULL AND t.merged_into_id IS NULL ${supplier} AND (:afterId::uuid IS NULL OR t.id > :afterId::uuid) ORDER BY t.id LIMIT :limit`,
    { companyId: tenant.companyId, afterId, limit }, transaction
  );
  return rows.map((row) => row.id);
}

module.exports = { loadContexts, listLiveIds };
