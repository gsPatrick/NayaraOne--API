'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const maskSpec = require('./retention.maskSpec');
const { DISPOSITIONS } = require('./retention.constants');

/**
 * Executa a disposição sobre um grupo de chaves, na transação do lote (M9-D911 §3.3.3 e §3.3.4). Só identificadores do catálogo fixo entram no SQL; as chaves vão como JSON.
 *  - DELETE: remove as linhas da empresa.
 *  - ARCHIVE: copia a linha (JSON + SHA-256) para governance.retention_archives, uma vez por registro; a linha de origem fica.
 *  - ANONYMIZE: troca os campos do alvo (e das tabelas filhas) por valor irreversível (HASH ou FULL do registro de classificação, via maskSpecFor), mantém as chaves
 *    técnicas e o que já é nulo continua nulo.
 */
const rows = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const IDS = 'IN (SELECT jsonb_array_elements_text(CAST(:ids AS jsonb))::uuid)';
const lengthCache = new Map();

/** Tamanho máximo do texto de cada coluna (varchar(n)); sem limite, 1000. */
async function maxLengths(schema, table, transaction) {
  const key = `${schema}.${table}`;
  if (!lengthCache.has(key)) {
    const found = await rows(`SELECT a.attname AS name, CASE WHEN a.atttypmod > 0 THEN a.atttypmod - 4 END AS len FROM pg_attribute a WHERE a.attrelid = CAST(:rel AS regclass) AND a.attnum > 0 AND NOT a.attisdropped`, { rel: `"${schema}"."${table}"` }, transaction);
    lengthCache.set(key, Object.fromEntries(found.map((row) => [row.name, row.len || 1000])));
  }
  return lengthCache.get(key);
}

const randomHash = (column) => `encode(sha256(convert_to(gen_random_uuid()::text || ${column}::text, 'UTF8')), 'hex')`;

/** Expressão do valor irreversível. HASH: hash com sal aleatório descartado (não se reverte nem se liga ao original). FULL: valor fixo, ou, em coluna com índice único, o hash com prefixo. */
function valueExpression(column, masking, distinct, len) {
  const body = masking === 'HASH' ? randomHash(column) : (distinct ? `'ANON-' || ${randomHash(column)}` : "'[ANONIMIZADO]'");
  return `CASE WHEN ${column} IS NULL THEN NULL ELSE left(${body}, ${Number(len)}) END`;
}

async function anonymizeTable(ctx, { schema, table, columns, keyColumn }, ids, transaction) {
  const lengths = await maxLengths(schema, table, transaction);
  const sets = [];
  for (const spec of columns) {
    const masking = await maskSpec.irreversibleMasking(schema, table, spec.column, { tenant: ctx.tenant, transaction });
    sets.push(`${spec.column} = ${valueExpression(spec.column, masking, spec.distinct, lengths[spec.column])}`);
  }
  const done = await rows(`UPDATE ${schema}.${table} SET ${sets.join(', ')}, updated_at = now() WHERE company_id = :companyId AND ${keyColumn} ${IDS} RETURNING id`, { companyId: ctx.tenant.companyId, ids: JSON.stringify(ids) }, transaction);
  return done.length;
}

async function dispose(ctx, target, disposition, ids, { policyCode, runId }, transaction) {
  const replacements = { companyId: ctx.tenant.companyId, groupId: ctx.tenant.groupId, ids: JSON.stringify(ids), policyCode, targetCode: target.code, runId };
  if (disposition === DISPOSITIONS.DELETE) return (await rows(`DELETE FROM ${target.schema}.${target.table} WHERE company_id = :companyId AND id ${IDS} RETURNING id`, replacements, transaction)).length;
  if (disposition === DISPOSITIONS.ARCHIVE) {
    const archived = await rows(
      `INSERT INTO governance.retention_archives (group_id, company_id, run_id, policy_code, target_code, record_id, content, content_hash)
       SELECT :groupId, :companyId, :runId, :policyCode, :targetCode, t.id::text, to_jsonb(t.*), encode(sha256(convert_to(to_jsonb(t.*)::text, 'UTF8')), 'hex')
         FROM ${target.schema}.${target.table} t WHERE t.company_id = :companyId AND t.id ${IDS}
       ON CONFLICT (company_id, target_code, record_id) DO NOTHING RETURNING id`, replacements, transaction);
    return archived.length;
  }
  if (disposition === DISPOSITIONS.ANONYMIZE) {
    const spec = target.anonymize;
    const root = await anonymizeTable(ctx, { schema: target.schema, table: target.table, columns: spec.columns, keyColumn: 'id' }, ids, transaction);
    for (const related of spec.related || []) await anonymizeTable(ctx, { schema: related.schema, table: related.table, columns: related.columns, keyColumn: related.fk }, ids, transaction);
    return root;
  }
  throw new Error(`Disposição sem execução: ${disposition}`);
}

module.exports = { dispose, valueExpression };
