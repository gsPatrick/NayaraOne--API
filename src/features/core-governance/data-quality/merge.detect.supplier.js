'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { REASONS, SUPPLIER_ROLE } = require('./merge.constants');
const { normText, digits, livePerson, supplierRole } = require('./merge.detect.sql');

/** Fornecedor é pessoa com o papel SUPPLIER: mesmo CNPJ raiz (8 primeiros dígitos) ou mesma razão social normalizada. */
async function detectSupplierPairs(tenant, config, transaction) {
  const rows = await sequelize.query(
    `WITH s AS (SELECT a.id, ${normText('a.legal_name')} AS name_key,
                       CASE WHEN length(${digits('a.tax_id_normalized')}) = 14 THEN left(${digits('a.tax_id_normalized')}, 8) END AS root
                  FROM people.persons a WHERE ${livePerson('a')} AND ${supplierRole('a')})
     SELECT a.id AS a_id, b.id AS b_id, true AS by_root, false AS by_name FROM s a JOIN s b ON a.root = b.root AND a.id < b.id WHERE a.root IS NOT NULL
     UNION ALL
     SELECT a.id, b.id, false, true FROM s a JOIN s b ON a.name_key = b.name_key AND a.id < b.id WHERE a.name_key <> ''`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, supplierRole: SUPPLIER_ROLE } }
  );
  return rows.flatMap((row) => [
    row.by_root ? { primaryId: row.a_id, secondaryId: row.b_id, reason: REASONS.SUPPLIER_CNPJ_ROOT, score: config.scores[REASONS.SUPPLIER_CNPJ_ROOT] } : null,
    row.by_name ? { primaryId: row.a_id, secondaryId: row.b_id, reason: REASONS.SUPPLIER_NAME, score: config.scores[REASONS.SUPPLIER_NAME] } : null,
  ].filter(Boolean));
}

module.exports = { detectSupplierPairs };
