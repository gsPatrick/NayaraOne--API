#!/usr/bin/env node
'use strict';

/**
 * M9-D442 — failure drill de provedor do Marketing: injeta os 12 cenários de falha em cada canal (sandbox da M9-D430) e confere o comportamento do sistema.
 *   npm run marketing:drill -- --canal=INSTAGRAM      (abre o banco descartável, semeia e roda)
 *   node scripts/withDisposableDb.js -- node scripts/marketingDrill.js --canal=todos --registrar
 * Saída 0 = todas as combinações aprovadas; 1 = divergência (MKT_DRILL_FAILED); 2 = uso incorreto ou banco não permitido. Este script nunca lê o .env.
 * A lógica está em src/features/marketing/publications/drill/drill.cli.js.
 */
const { runCli } = require('../src/features/marketing/publications/drill/drill.cli');

runCli(process.argv.slice(2))
  .then(async (code) => {
    const { sequelize } = require('../src/models');
    await sequelize.close();
    process.exit(code);
  })
  .catch((e) => { console.error(`MKT_DRILL_FAILED: falha do ensaio: ${e.message}`); process.exit(1); });
