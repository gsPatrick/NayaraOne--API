'use strict';

/**
 * M4-D140 (cenário 2, teste 9): impressão digital do schema de um banco, lida só dos catálogos do PostgreSQL —
 * colunas, restrições, índices, gatilhos, funções, views, políticas de RLS, RLS ligada/forçada, GRANTs de tabela,
 * sequências, enums, comentários e as linhas da SequelizeMeta. É o equivalente ao `pg_dump --schema-only` sem
 * depender do binário (o CI tem só o servidor). Os instantes gravados pelas migrations em CHECK/índice parcial
 * (`created_at < '<agora da migration>'`) mudam a cada execução e viram um marcador, como na comparação do dump.
 *   const { fingerprint } = require('./schemaFingerprint'); await fingerprint(async (sql) => rows)
 */
const crypto = require('node:crypto');

const SCHEMAS = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";
const INSTANTE = /'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}(?::\d{2})?'::timestamp with time zone/g;

const CONSULTAS = {
  colunas: `SELECT n.nspname, c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS tipo, a.attnotnull,
      pg_get_expr(d.adbin, d.adrelid) AS padrao
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE ${SCHEMAS} AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped`,
  restricoes: `SELECT n.nspname, c.relname, k.conname, pg_get_constraintdef(k.oid) AS def
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS}`,
  indices: `SELECT schemaname AS nspname, tablename, indexname, indexdef FROM pg_indexes n WHERE ${SCHEMAS.replace(/n\.nspname/g, 'schemaname')}`,
  gatilhos: `SELECT n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def, t.tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS} AND NOT t.tgisinternal`,
  funcoes: `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, md5(pg_get_functiondef(p.oid)) AS def, p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${SCHEMAS} AND p.prokind IN ('f','p')`,
  views: `SELECT n.nspname, c.relname, c.relkind, md5(pg_get_viewdef(c.oid)) AS def, c.reloptions::text AS opcoes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS} AND c.relkind IN ('v','m')`,
  politicas: `SELECT schemaname AS nspname, tablename, policyname, permissive, roles::text, cmd, qual, with_check FROM pg_policies n
    WHERE ${SCHEMAS.replace(/n\.nspname/g, 'schemaname')}`,
  rls: `SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS} AND c.relkind IN ('r','p')`,
  grants: `SELECT table_schema AS nspname, table_name, grantee, privilege_type FROM information_schema.role_table_grants n
    WHERE ${SCHEMAS.replace(/n\.nspname/g, 'table_schema')} AND grantee <> current_user`, // o dono (quem migrou) muda de ambiente para ambiente
  sequencias: `SELECT sequence_schema AS nspname, sequence_name, data_type, increment FROM information_schema.sequences n
    WHERE ${SCHEMAS.replace(/n\.nspname/g, 'sequence_schema')}`,
  enums: `SELECT n.nspname, t.typname, e.enumsortorder, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace WHERE ${SCHEMAS}`,
  comentarios: `SELECT n.nspname, c.relname, d.objsubid, d.description FROM pg_description d JOIN pg_class c ON c.oid = d.objoid
    AND d.classoid = 'pg_class'::regclass JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS}`,
  schemas: `SELECT n.nspname FROM pg_namespace n WHERE ${SCHEMAS}`,
  sequelizeMeta: 'SELECT name FROM public."SequelizeMeta"',
};

const sha = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

function linhas(rows) {
  return rows
    .map((r) => JSON.stringify(Object.values(r)).replace(INSTANTE, "'<instante-da-migration>'::timestamp with time zone"))
    .sort();
}

/** `consultar(sql)` devolve as linhas (array de objetos). Retorna { sha256, categorias: { nome: { linhas, sha256 } } }. */
async function fingerprint(consultar) {
  const categorias = {};
  for (const [nome, sql] of Object.entries(CONSULTAS)) {
    const l = linhas(await consultar(sql));
    categorias[nome] = { linhas: l.length, sha256: sha(l.join('\n')) };
  }
  return { sha256: sha(JSON.stringify(categorias)), categorias };
}

module.exports = { fingerprint, CONSULTAS };
