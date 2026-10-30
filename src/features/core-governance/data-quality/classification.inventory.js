'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DOCUMENT, TECHNICAL_COLUMNS, SYSTEM_SCHEMAS } = require('./classification.constants');

/**
 * O inventário versionado das colunas de negócio (`docs/governance/data-classification.json`, M9-D910 §3.2.1): quais colunas existem e os ajustes manuais (overrides)
 * à classificação automática. É o que faz o CI reprovar coluna nova sem classificação: `npm run check:classification` compara este arquivo com o catálogo do banco migrado
 * e `npm run sync:classification` o atualiza (a coluna nova entra com a classificação automática, para revisão humana no diff).
 */
const FILE = path.resolve(__dirname, '../../../../', DOCUMENT);
const keyOf = (schema, table, column) => `${schema}.${table}.${column}`;
const isTechnical = (column) => TECHNICAL_COLUMNS.includes(column);

/** Catálogo do banco -> { "schema.tabela": [colunas] } só com colunas de negócio. `rows` = [{ schema_name, table_name, column_name }]. */
function columnsFromCatalog(rows) {
  const out = {};
  for (const row of rows) {
    if (SYSTEM_SCHEMAS.includes(row.schema_name) || isTechnical(row.column_name)) continue;
    const key = `${row.schema_name}.${row.table_name}`;
    (out[key] = out[key] || []).push(row.column_name);
  }
  return Object.fromEntries(Object.keys(out).sort().map((key) => [key, [...new Set(out[key])].sort()]));
}

/** SQL (pg_catalog, não depende de privilégio) que lista as colunas de tabelas de negócio. */
const CATALOG_SQL = `SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
  ORDER BY 1, 2, 3`;

function read(file = FILE) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { version: data.version || 1, columns: data.columns || {}, overrides: data.overrides || {} };
}

function serialize({ columns, overrides }) {
  const sortedOverrides = Object.fromEntries(Object.keys(overrides).sort().map((key) => [key, overrides[key]]));
  return `${JSON.stringify({
    _comment: 'Inventário das colunas de negócio e ajustes manuais da classificação (M9-D910). Gerado por npm run sync:classification; a classificação de cada coluna é calculada pelas regras (classification.rules.js) e pelos overrides daqui. Coluna nova sem entrada reprova o CI (GOV_CLASSIFICATION_MISSING).',
    version: 1, columns, overrides: sortedOverrides,
  }, null, 1)}\n`;
}

const write = (data, file = FILE) => fs.writeFileSync(file, serialize(data));
const flatten = (columns) => Object.entries(columns).flatMap(([table, list]) => list.map((column) => `${table}.${column}`));

/** Compara o inventário com o catálogo: `missing` = coluna do banco sem entrada (reprova o CI); `stale` = entrada de coluna que não existe mais. */
function diff(inventoryColumns, catalogColumns) {
  const have = new Set(flatten(inventoryColumns));
  const real = new Set(flatten(catalogColumns));
  return { missing: [...real].filter((key) => !have.has(key)).sort(), stale: [...have].filter((key) => !real.has(key)).sort() };
}

module.exports = { FILE, CATALOG_SQL, keyOf, isTechnical, columnsFromCatalog, read, write, serialize, flatten, diff };
