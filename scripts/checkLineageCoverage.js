#!/usr/bin/env node
'use strict';

/**
 * M9-D811 — portão de CI: KPI crítico sem lineage reprova o build.
 *   node scripts/checkLineageCoverage.js [--registry arquivo] [--catalog arquivo] [--map arquivo] [--json]
 * Lê o catálogo de indicadores do código (tabela de criticidade do BI, com a `area` de cada entrada), o registro versionado
 * (docs/governance/lineage-registry.json, gerado só por scripts/syncLineageRegistry.js) e, se existir, o mapa de campos da migração
 * (docs/governance/migration-field-map.json, da M9-D914). Não abre banco nem o aplicativo. Saída 0 = ok, 1 = reprovado, 2 = erro (arquivo ilegível ou uso).
 * Não existe lista de exceções.
 */
const fs = require('node:fs');
const path = require('node:path');
const { evaluate } = require('../src/features/core-governance/lineage/lineage.gate');
const { registryProblem } = require('../src/features/core-governance/lineage/lineage.registryFormat');
const { catalogEntries } = require('../src/features/core-governance/lineage/lineage.catalog');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = { registry: path.join(ROOT, 'docs/governance/lineage-registry.json'), map: path.join(ROOT, 'docs/governance/migration-field-map.json') };
const OPTIONS = new Set(['--registry', '--catalog', '--map']);

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (OPTIONS.has(arg) && argv[i + 1] !== undefined) { out[arg.slice(2)] = argv[i + 1]; i += 1; }
    else return { error: `Uso: node scripts/checkLineageCoverage.js [--registry arquivo] [--catalog arquivo] [--map arquivo] [--json] (opção inválida: ${arg})` };
  }
  return out;
}

function fail(code, message, json, status) {
  if (json) console.log(JSON.stringify({ ok: false, code, message }));
  else console.error(`${code}: ${message}`);
  process.exit(status);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(args.error); process.exit(2); }
  let registry;
  try {
    registry = readJson(args.registry || DEFAULTS.registry);
    if (registryProblem(registry)) throw new Error(registryProblem(registry));
  } catch (_err) {
    return fail('GOV_LINEAGE_REGISTRY_INVALID', 'Arquivo de lineage inválido.', args.json, 2);
  }
  let catalog;
  try { catalog = args.catalog ? readJson(args.catalog) : catalogEntries(); if (!Array.isArray(catalog)) throw new Error('catálogo'); } catch (_err) {
    return fail('GOV_LINEAGE_REGISTRY_INVALID', 'Catálogo de indicadores ilegível.', args.json, 2);
  }
  let map = null;
  const mapFile = args.map || DEFAULTS.map;
  if (fs.existsSync(mapFile)) {
    try { map = readJson(mapFile); if (!Array.isArray(map)) throw new Error('mapa'); } catch (_err) {
      return fail('GOV_LINEAGE_REGISTRY_INVALID', 'Mapa de migração ilegível.', args.json, 2);
    }
  }
  const result = evaluate({ registry, catalog, map });
  const uncoveredCodes = result.uncovered.map((item) => item.code);
  if (args.json) console.log(JSON.stringify({ ok: !result.errors.length, critical: result.critical, covered: result.covered, uncovered: uncoveredCodes, errors: result.errors }));
  else {
    for (const error of result.errors) console.log(`${error.code}: ${error.message}${error.area ? ` (área ${error.area})` : ''}`);
    console.log(`lineage: covered=${result.covered}/${result.critical} percent=${result.percent} uncovered=${JSON.stringify(uncoveredCodes)}`);
  }
  process.exit(result.errors.length ? 1 : 0);
}

main();
