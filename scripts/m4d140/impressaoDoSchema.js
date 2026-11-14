#!/usr/bin/env node
'use strict';

/**
 * M4-D140 (teste 9): imprime a impressão digital do schema do banco de DATABASE_URL (scripts/lib/schemaFingerprint.js).
 * Com --gravar, grava test/fixtures/m4d140-schema-antes.json — o retrato tirado de um banco vazio migrado no commit
 * base, antes da reorganização (somente leitura: só consulta catálogos).
 *   DATABASE_URL=postgres://... node scripts/m4d140/impressaoDoSchema.js [--gravar --commit <sha>]
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { fingerprint } = require('../lib/schemaFingerprint');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const resultado = await fingerprint(async (sql) => (await client.query(sql)).rows);
    await client.query('ROLLBACK');
    const argv = process.argv.slice(2);
    if (argv.includes('--gravar')) {
      const commit = argv.includes('--commit') ? argv[argv.indexOf('--commit') + 1] : 'desconhecido';
      const destino = path.join(__dirname, '..', '..', 'test', 'fixtures', 'm4d140-schema-antes.json');
      fs.writeFileSync(destino, `${JSON.stringify({ demanda: 'M4-D140', geradoNoCommit: commit, origem: 'banco vazio migrado no commit base', ...resultado }, null, 2)}\n`);
      console.log(`gravado ${path.relative(process.cwd(), destino)}: ${resultado.sha256}`);
    } else {
      console.log(JSON.stringify(resultado, null, 2));
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
