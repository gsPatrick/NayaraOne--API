#!/usr/bin/env node
'use strict';

/**
 * M9-D871 §3.3 — relatório de CI das flags declaradas: lê docs/governance/flags.json (gerado por scripts/syncFlagsRegistry.js) e reprova (exit 1) quando existe flag temporária
 * vencida (GOV_FLAG_EXPIRED) ou temporária sem validade (GOV_FLAG_EXPIRY_REQUIRED). Saída JSON na saída padrão e, com --out, também no arquivo (artefato do CI).
 *   npm run check:flags [-- --file <flags.json>] [--now <ISO>] [--out <relatorio.json>]
 * O CI não lê o banco: as flags criadas em tempo de execução são cobertas pelo featureFlagExpiryJob (06:30) e pela notificação ao responsável.
 */
const fs = require('node:fs');
const path = require('node:path');
const { REGISTRY_FILE, readRegistry } = require('../src/features/core-governance/feature-flags/registry/registry.file');
const { evaluateRegistry } = require('../src/features/core-governance/feature-flags/registry/registry.check');

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const file = path.resolve(arg('--file') || REGISTRY_FILE);
const now = arg('--now') ? new Date(arg('--now')) : new Date();

let registry;
try {
  if (Number.isNaN(now.getTime())) throw new Error('--now deve ser uma data ISO.');
  registry = readRegistry(file);
} catch (err) {
  console.error(`GOV_FLAG_REGISTRY_UNREADABLE Não foi possível ler ${path.relative(process.cwd(), file)}: ${err.message} Rode npm run sync:flags.`);
  process.exit(1);
}

const report = evaluateRegistry(registry, now);
const json = `${JSON.stringify(report, null, 2)}\n`;
if (arg('--out')) { fs.mkdirSync(path.dirname(path.resolve(arg('--out'))), { recursive: true }); fs.writeFileSync(path.resolve(arg('--out')), json); }
process.stdout.write(json);
for (const item of [...report.expired, ...report.missingExpiry]) console.error(`${item.code} ${item.message}`);
process.exit(report.ok ? 0 : 1);
