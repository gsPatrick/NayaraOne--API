'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { REASONS, SUPPLIER_ROLE } = require('./merge.constants');
const { normText, digits, livePerson, supplierRole } = require('./merge.detect.sql');
const { distance } = require('./merge.detect.levenshtein');

const pair = (reason, scores) => (row) => ({ primaryId: row.a_id, secondaryId: row.b_id, reason, score: scores[reason] });
const select = (sql, tenant, extra = {}, transaction) => sequelize.query(sql, {
  type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, supplierRole: SUPPLIER_ROLE, ...extra },
});

/** Mesmo CPF/CNPJ (pelo hash ou pelos dígitos, mesmo digitado de jeitos diferentes). */
async function byTaxId(tenant, scores, transaction) {
  const rows = await select(
    `SELECT a.id AS a_id, b.id AS b_id FROM people.persons a JOIN people.persons b ON b.company_id = a.company_id AND a.id < b.id
      WHERE ${livePerson('a')} AND ${livePerson('b')}
        AND ((a.tax_id_normalized_hash IS NOT NULL AND a.tax_id_normalized_hash = b.tax_id_normalized_hash)
          OR (${digits('a.tax_id_normalized')} <> '' AND ${digits('a.tax_id_normalized')} = ${digits('b.tax_id_normalized')}))`,
    tenant, {}, transaction
  );
  return rows.map(pair(REASONS.PERSON_TAX_ID, scores));
}

/** Nome normalizado idêntico mais o mesmo telefone ou e-mail. */
async function byNameAndContact(tenant, scores, transaction) {
  const rows = await select(
    `WITH p AS (SELECT a.id, ${normText('a.legal_name')} AS name_key FROM people.persons a WHERE ${livePerson('a')}),
          c AS (SELECT person_id, value_normalized FROM people.person_contacts WHERE company_id = :companyId AND deleted_at IS NULL AND value_normalized IS NOT NULL AND value_normalized <> '')
     SELECT a.id AS a_id, b.id AS b_id FROM p a JOIN p b ON a.name_key = b.name_key AND a.id < b.id AND a.name_key <> ''
      WHERE EXISTS (SELECT 1 FROM c ca JOIN c cb ON cb.value_normalized = ca.value_normalized WHERE ca.person_id = a.id AND cb.person_id = b.id)`,
    tenant, {}, transaction
  );
  return rows.map(pair(REASONS.PERSON_NAME_CONTACT, scores));
}

/** Nome com distância de edição até o limite e a mesma data de nascimento ou fundação. */
async function byNameAndBirth(tenant, scores, nameDistance, transaction) {
  const rows = await select(
    `SELECT a.id, a.birth_or_foundation_date::text AS birth, ${normText('a.legal_name')} AS name_key FROM people.persons a
      WHERE ${livePerson('a')} AND a.birth_or_foundation_date IS NOT NULL
        AND a.birth_or_foundation_date IN (SELECT x.birth_or_foundation_date FROM people.persons x WHERE ${livePerson('x')} AND x.birth_or_foundation_date IS NOT NULL GROUP BY 1 HAVING count(*) > 1)
      ORDER BY a.birth_or_foundation_date, a.id`,
    tenant, {}, transaction
  );
  const groups = new Map();
  rows.forEach((row) => groups.set(row.birth, [...(groups.get(row.birth) || []), row]));
  const found = [];
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const [a, b] = members[i].id < members[j].id ? [members[i], members[j]] : [members[j], members[i]];
        if (a.name_key && distance(a.name_key, b.name_key, nameDistance) <= nameDistance) {
          found.push({ primaryId: a.id, secondaryId: b.id, reason: REASONS.PERSON_NAME_BIRTH, score: scores[REASONS.PERSON_NAME_BIRTH] });
        }
      }
    }
  }
  return found;
}

/** Pares em que as duas pessoas são fornecedoras: vão para a fila de SUPPLIER, não para a de PERSON. */
async function supplierIds(tenant, transaction) {
  const rows = await select(`SELECT a.id FROM people.persons a WHERE ${livePerson('a')} AND ${supplierRole('a')}`, tenant, {}, transaction);
  return new Set(rows.map((row) => row.id));
}

async function detectPersonPairs(tenant, config, transaction) {
  const { scores } = config;
  const found = [
    ...(await byTaxId(tenant, scores, transaction)),
    ...(await byNameAndContact(tenant, scores, transaction)),
    ...(await byNameAndBirth(tenant, scores, config.nameDistance, transaction)),
  ];
  const suppliers = await supplierIds(tenant, transaction);
  return found.filter((item) => !(suppliers.has(item.primaryId) && suppliers.has(item.secondaryId)));
}

module.exports = { detectPersonPairs };
