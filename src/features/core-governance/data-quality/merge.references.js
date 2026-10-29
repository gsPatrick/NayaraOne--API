'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { govError } = require('../governance.errors');
const { TABLE_OF } = require('./merge.repository');
const { SUPPLIER_EXTRA_REFERENCES, FILE_LINK_TYPES, DERIVED_TABLES } = require('./merge.constants');

const ident = (value) => `"${String(value).replace(/"/g, '""')}"`;
const qualified = (name) => name.split('.').map(ident).join('.');

/**
 * Colunas que apontam por chave estrangeira para o cadastro (descobertas no catálogo do banco, então uma tabela nova com FK de pessoa ou imóvel
 * também é reapontada) menos o próprio merged_into_id e as tabelas de leitura derivada. Devolve [{ table, column }].
 */
async function foreignReferences(entityType, transaction) {
  const target = TABLE_OF[entityType];
  const rows = await sequelize.query(
    `SELECT n.nspname || '.' || c.relname AS table_name, a.attname AS column_name FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.confrelid = CAST(:target AS regclass) AND array_length(k.conkey, 1) = 1 ORDER BY 1, 2`,
    { type: QueryTypes.SELECT, transaction, replacements: { target } }
  );
  return rows.map((row) => ({ table: row.table_name, column: row.column_name }))
    .filter((ref) => !(ref.table === target && ref.column === 'merged_into_id') && !DERIVED_TABLES.includes(ref.table));
}

/** Referências sem chave estrangeira da lista fechada (fornecedor em compras e estoque). */
const extraReferences = (entityType) => (entityType === 'SUPPLIER' ? SUPPLIER_EXTRA_REFERENCES.map(([table, column]) => ({ table, column })) : []);

const allReferences = async (entityType, transaction) => [...(await foreignReferences(entityType, transaction)), ...extraReferences(entityType)];

/** Quantas linhas apontam para o cadastro que sai, por tabela (só as que têm linha). Usado pela rota /impact. */
async function countReferences(entityType, otherId, transaction) {
  const counts = {};
  for (const { table, column } of await allReferences(entityType, transaction)) {
    const [{ n }] = await sequelize.query(`SELECT count(*)::int AS n FROM ${qualified(table)} WHERE ${ident(column)} = :otherId`, { type: QueryTypes.SELECT, transaction, replacements: { otherId } });
    if (n > 0) counts[`${table}.${column}`] = n;
  }
  const [{ n: links }] = await sequelize.query(
    'SELECT count(*)::int AS n FROM people.file_links WHERE related_entity_id = :otherId AND related_entity_type IN (:types)', { type: QueryTypes.SELECT, transaction, replacements: { otherId, types: FILE_LINK_TYPES[entityType] } }
  );
  if (links > 0) counts['people.file_links.related_entity_id'] = links;
  return counts;
}

async function update(table, column, survivorId, otherId, transaction) {
  const [, meta] = await sequelize.query(`UPDATE ${qualified(table)} SET ${ident(column)} = :survivorId WHERE ${ident(column)} = :otherId`, { transaction, replacements: { survivorId, otherId } });
  return meta && meta.rowCount ? meta.rowCount : 0;
}

/**
 * Reaponta, na transação da decisão, o que os serviços de cada módulo ainda não moveram: toda FK que sobrou para o cadastro absorvido, as
 * referências sem FK da lista fechada, os convites de cotação (jsonb) e os vínculos de arquivos. Conflito de unicidade desfaz tudo (422).
 * Devolve o mapa tabela.coluna -> linhas movidas.
 */
async function remapLeftovers(entityType, survivorId, otherId, transaction) {
  const moved = {};
  try {
    for (const { table, column } of await allReferences(entityType, transaction)) {
      const count = await update(table, column, survivorId, otherId, transaction);
      if (count) moved[`${table}.${column}`] = count;
    }
    const [, links] = await sequelize.query(
      'UPDATE people.file_links SET related_entity_id = :survivorId WHERE related_entity_id = :otherId AND related_entity_type IN (:types)',
      { transaction, replacements: { survivorId, otherId, types: FILE_LINK_TYPES[entityType] } }
    );
    if (links && links.rowCount) moved['people.file_links.related_entity_id'] = links.rowCount;
    if (entityType === 'SUPPLIER') {
      const [, invites] = await sequelize.query(
        `UPDATE procurement.quotations SET invited_supplier_ids = (SELECT jsonb_agg(DISTINCT CASE WHEN e = to_jsonb(CAST(:otherId AS text)) THEN to_jsonb(CAST(:survivorId AS text)) ELSE e END) FROM jsonb_array_elements(invited_supplier_ids) e)
          WHERE jsonb_typeof(invited_supplier_ids) = 'array' AND invited_supplier_ids @> to_jsonb(ARRAY[CAST(:otherId AS text)])`,
        { transaction, replacements: { survivorId, otherId } }
      );
      if (invites && invites.rowCount) moved['procurement.quotations.invited_supplier_ids'] = invites.rowCount;
    }
    if (entityType === 'PROPERTY') {
      await sequelize.query('DELETE FROM real_estate.public_property_read_model WHERE property_id = :otherId', { transaction, replacements: { otherId } });
      await sequelize.query('UPDATE real_estate.properties SET merged_into_id = :survivorId WHERE id = :otherId', { transaction, replacements: { survivorId, otherId } });
    }
  } catch (err) {
    if (err && err.original && err.original.code === '23505') {
      throw govError(409, 'GOV_MERGE_REFERENCE_CONFLICT', 'Não foi possível unir: um dado ligado aos dois cadastros entra em conflito ao ser unificado. Revise os cadastros.', { constraint: err.original.constraint });
    }
    throw err;
  }
  return moved;
}

module.exports = { foreignReferences, countReferences, remapLeftovers };
