#!/usr/bin/env node
'use strict';
/**
 * Atualiza o inventário versionado das colunas (docs/governance/data-classification.json, M9-D910) a partir do banco migrado: coluna nova entra (a classificação dela vem
 * das regras automáticas e é revista por humano no diff), coluna que não existe mais sai, e os overrides manuais são preservados.
 *   npm run sync:classification
 */
const inventory = require('../src/features/core-governance/data-quality/classification.inventory');
const { withClient } = require('./lib/classificationDb');

async function main() {
  const catalog = await withClient(async (client) => inventory.columnsFromCatalog((await client.query(inventory.CATALOG_SQL)).rows));
  const current = inventory.read();
  const result = inventory.diff(current.columns, catalog);
  const overrides = Object.fromEntries(Object.entries(current.overrides).filter(([key]) => !result.stale.includes(key)));
  inventory.write({ columns: catalog, overrides });
  console.log(`Inventário atualizado: +${result.missing.length} coluna(s), -${result.stale.length} coluna(s); ${inventory.flatten(catalog).length} colunas de negócio.`);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
