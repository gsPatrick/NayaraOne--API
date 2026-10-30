'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** Colunas de outras tabelas que apontam para people.files por chave estrangeira simples (evidência de transferência, anexos de nota etc.): arquivo usado ali tem vínculo. */
async function referencingColumns(transaction) {
  return sequelize.query(
    `SELECT n.nspname AS schema, c.relname AS "table", a.attname AS col
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.confrelid = 'people.files'::regclass AND array_length(k.conkey, 1) = 1 ORDER BY 1, 2, 3`,
    { type: QueryTypes.SELECT, transaction }
  );
}

const ident = (v) => `"${String(v).replace(/"/g, '""')}"`;

/**
 * Arquivos do módulo de arquivos da empresa (M9-D862 §3.1) que estão há mais de `orphanDays` dias SEM vínculo (nenhuma linha em people.file_links nem em coluna
 * de outra tabela que referencie o arquivo) E SEM dono (sem quem enviou, ou quem enviou não é mais membro ativo da empresa). Devolve { count, bytes, ids }.
 */
async function orphanFiles(tenant, cutoff, transaction) {
  const links = (await referencingColumns(transaction)).map((r) => `NOT EXISTS (SELECT 1 FROM ${ident(r.schema)}.${ident(r.table)} t WHERE t.${ident(r.col)} = f.id)`);
  const rows = await sequelize.query(
    `SELECT f.id, COALESCE(f.size_bytes, 0)::bigint AS bytes FROM people.files f
      WHERE f.company_id = :companyId AND f.deleted_at IS NULL AND f.created_at < :cutoff
        AND NOT EXISTS (SELECT 1 FROM people.file_links l WHERE l.file_id = f.id)${links.length ? ` AND ${links.join(' AND ')}` : ''}
        AND (f.uploaded_by_user_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id
           WHERE m.user_id = f.uploaded_by_user_id AND m.company_id = f.company_id AND m.deleted_at IS NULL AND m.status = 'ACTIVE' AND u.deleted_at IS NULL AND u.status = 'ACTIVE'))
      ORDER BY f.created_at`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, cutoff } }
  );
  return { count: rows.length, bytes: rows.reduce((sum, r) => sum + BigInt(r.bytes), 0n), ids: rows.slice(0, 20).map((r) => r.id) };
}

/** Todas as chaves que a empresa conhece (arquivos, vivos ou não, e quarentena), na forma `company/<id>/<chave>` e na forma gravada. */
async function knownKeys(tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT storage_key FROM people.files WHERE company_id = :companyId AND storage_key IS NOT NULL
     UNION ALL SELECT storage_key FROM files.quarantine WHERE company_id = :companyId AND storage_key IS NOT NULL`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } }
  );
  const keys = new Set();
  for (const r of rows) {
    const k = String(r.storage_key);
    keys.add(k);
    keys.add(`company/${String(tenant.companyId).toLowerCase()}/${k}`);
  }
  return keys;
}

module.exports = { orphanFiles, knownKeys, referencingColumns };
