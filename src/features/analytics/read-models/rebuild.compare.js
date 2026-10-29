'use strict';

/**
 * M9-D608 (3.2 passo 4 e 3.3) — comparação entre a tabela atual e a sombra, por empresa: contagem de linhas, hash e diferença por chave
 * (acrescentadas, removidas, alteradas). O hash cobre só o conteúdo de negócio (chave e campos do read model): source_snapshot_at,
 * refreshed_at, version, company_id e group_id são metadados e ficam de fora, então o incremental e o rebuild com as mesmas fontes têm hash igual.
 */
const { sequelize } = require('../../../models');
const { shadowName } = require('./rebuild.shadow');

const META = ['source_snapshot_at', 'refreshed_at', 'version', 'company_id', 'group_id'];
const T = (name) => `analytics."${name}"`;

const contentOf = (alias) => `(to_jsonb(${alias}) - ARRAY[${META.map((c) => `'${c}'`).join(', ')}])`;

/** { rows, hash } do conteúdo da empresa na tabela (SHA-256 das linhas em ordem canônica; vazio = hash do texto vazio). */
async function tableStats(table, companyId, transaction) {
  const [[row]] = await sequelize.query(
    `SELECT count(*)::int AS rows,
            encode(sha256(convert_to(COALESCE(string_agg(c::text, E'\\n' ORDER BY c::text), ''), 'UTF8')), 'hex') AS hash
       FROM (SELECT ${contentOf('t')} AS c FROM ${T(table)} t WHERE t.company_id = :companyId) x`,
    { replacements: { companyId }, transaction }
  );
  return { rows: row.rows, hash: row.hash };
}

/** Linhas acrescentadas, removidas e alteradas pela sombra em relação à atual (campo a campo, pela chave do agregado). */
async function diffByKey(def, companyId, transaction) {
  const keyExpr = (alias) => `jsonb_build_array(${def.keyColumns.map((c) => `${alias}."${c}"`).join(', ')})::text`;
  const side = (table, alias) => `SELECT ${keyExpr(alias)} AS k, ${contentOf(alias)} AS c FROM ${T(table)} ${alias} WHERE ${alias}.company_id = :companyId`;
  const [[row]] = await sequelize.query(
    `SELECT count(*) FILTER (WHERE l.k IS NULL)::int AS added,
            count(*) FILTER (WHERE s.k IS NULL)::int AS removed,
            count(*) FILTER (WHERE l.k IS NOT NULL AND s.k IS NOT NULL AND l.c <> s.c)::int AS changed
       FROM (${side(def.name, 'a')}) l FULL JOIN (${side(shadowName(def.name), 'b')}) s ON l.k = s.k`,
    { replacements: { companyId }, transaction }
  );
  return row;
}

/** Diferença completa entre atual e sombra. `different` é verdadeiro se qualquer linha entra, sai ou muda. */
async function compareWithShadow(def, companyId, transaction) {
  const before = await tableStats(def.name, companyId, transaction);
  const after = await tableStats(shadowName(def.name), companyId, transaction);
  const delta = await diffByKey(def, companyId, transaction);
  return { before, after, ...delta, different: before.hash !== after.hash || before.rows !== after.rows };
}

module.exports = { tableStats, compareWithShadow, META };
