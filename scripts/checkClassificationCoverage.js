#!/usr/bin/env node
'use strict';
/**
 * Portão de CI da cobertura do registro de classificação (M9-D910 §3.2.1): lê o catálogo do banco MIGRADO (todos os schemas de negócio) e reprova (exit 1) se existir
 * coluna sem entrada no inventário versionado (docs/governance/data-classification.json), com o código GOV_CLASSIFICATION_MISSING. Exceto as colunas técnicas
 * (id, created_at, updated_at, group_id, company_id). Entrada de coluna que não existe mais é só avisada (STALE). Corrigir: npm run sync:classification e revisar o diff.
 *   npm run check:classification            (sobe um banco descartável, migra e confere)
 *   node scripts/withDisposableDb.js -- node scripts/checkClassificationCoverage.js [--json]
 */
const inventory = require('../src/features/core-governance/data-quality/classification.inventory');
const { withClient } = require('./lib/classificationDb');

async function main() {
  const json = process.argv.includes('--json');
  const catalog = await withClient(async (client) => inventory.columnsFromCatalog((await client.query(inventory.CATALOG_SQL)).rows));
  const result = inventory.diff(inventory.read().columns, catalog);
  const total = inventory.flatten(catalog).length;
  const percent = total ? Math.round(((total - result.missing.length) / total) * 1000) / 10 : 100;
  if (json) console.log(JSON.stringify({ total, covered: total - result.missing.length, percent, missing: result.missing, stale: result.stale }));
  else {
    for (const key of result.missing) console.error(`GOV_CLASSIFICATION_MISSING ${key}`);
    for (const key of result.stale) console.warn(`STALE ${key} (entrada de coluna que não existe mais)`);
    console.log(result.missing.length ? `FALHOU: ${result.missing.length} coluna(s) sem classificação (cobertura ${percent}% de ${total}). Rode npm run sync:classification.` : `OK: cobertura de classificação ${percent}% (${total} colunas de negócio).`);
  }
  process.exit(result.missing.length ? 1 : 0);
}

main().catch((err) => { console.error(err.message); process.exit(2); });
