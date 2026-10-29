#!/usr/bin/env node
'use strict';

/**
 * M9-D046 — relatório de red-team da NAY (provider sandbox). Só em banco descartável:
 *   node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js && node scripts/ai-redteam.js"
 * Grava docs/evidencias/ai/redteam/redteam-<data>.json; sai com 0 só se não houver achado GRAVE ou MEDIO aberto (o relatório é a evidência do item RED_TEAM).
 */
const fs = require('node:fs');
const path = require('node:path');
const { exigirBancoDescartavel } = require('./ai-drill/lib/runner');

async function main() {
  exigirBancoDescartavel();
  const F = require('../test/marco9/_helpers/advFixtures');
  const { executarRedTeam } = require('./ai-redteam/executar');
  let relatorio;
  try {
    const { tenantA } = await F.empresas();
    relatorio = await executarRedTeam(F, tenantA);
  } finally {
    await F.sequelize.close();
  }
  const pasta = path.join(__dirname, '..', 'docs', 'evidencias', 'ai', 'redteam');
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, `redteam-${relatorio.executadoEm.slice(0, 10)}.json`);
  fs.writeFileSync(arquivo, `${JSON.stringify(relatorio, null, 2)}\n`);
  console.log(JSON.stringify({ resultado: relatorio.resultado, execucoes: relatorio.execucoes, achados: relatorio.achados.length, registro: path.relative(process.cwd(), arquivo) }, null, 2));
  process.exitCode = relatorio.resultado === 'APROVADO' ? 0 : 1;
}

main().catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });
