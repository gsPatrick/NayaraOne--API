#!/usr/bin/env node
'use strict';

/**
 * secretScan.js (M9-D246 3.2.2/3.2.3) — varredura estática de segredo no repositório e nos logs de CI guardados
 * em docs/evidencias/ci. Roda no CI antes dos testes e bloqueia o merge: sai com 1 e o código
 * INTEGRATION_SECRET_SCAN_FAILED se achar qualquer padrão fora da allowlist revisada.
 * Uso: node scripts/secretScan.js [--allowlist <arquivo>] [--root <pasta>] [--extra <arquivo de log>]
 */
const path = require('node:path');
const { scanRepository } = require('./lib/secretScanner');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const root = path.resolve(argValue('--root', path.join(__dirname, '..')));
  const allowlistFile = path.resolve(argValue('--allowlist', path.join(__dirname, 'secretScan.allowlist.json')));
  const extra = argValue('--extra', null);
  const { findings, scanned } = scanRepository({ root, allowlistFile, extraFiles: extra ? [extra] : [] });
  if (findings.length === 0) {
    console.log(`secretScan: 0 achados em ${scanned} arquivos.`);
    return 0;
  }
  console.error('INTEGRATION_SECRET_SCAN_FAILED: Segredo encontrado no código ou em logs: remova e rotacione.');
  for (const f of findings) console.error(`  ${f.file}:${f.line} [${f.pattern}] ${f.sample}`);
  console.error(`secretScan: ${findings.length} achado(s) em ${scanned} arquivos. Segredo real exige rotação; falso positivo exige entrada revisada na allowlist.`);
  return 1;
}

process.exitCode = main();
