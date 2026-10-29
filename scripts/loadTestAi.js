#!/usr/bin/env node
'use strict';

/**
 * M9-D046 — carga da NAY (modelo: scripts/loadTestConstruction.js). Só em banco descartável com o seed de duas empresas:
 *   node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js && node scripts/loadTestAi.js"
 * Volume: scripts/ai-load/volume.js (fixture, não meta de desempenho). Sai com 0 só se as quatro invariantes ficarem em zero violações.
 */
const fs = require('node:fs');
const path = require('node:path');
const { exigirBancoDescartavel } = require('./ai-drill/lib/runner');

async function main() {
  exigirBancoDescartavel();
  const { executarCarga, F } = require('./ai-load/executar');
  let relatorio;
  try {
    const { tenantA, tenantB } = await F.empresas();
    relatorio = await executarCarga([tenantA, tenantB]);
  } finally {
    await F.sequelize.close();
  }
  const pasta = path.join(__dirname, '..', 'docs', 'evidencias', 'ai', 'carga');
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, `carga-${relatorio.executadoEm.slice(0, 10)}.json`);
  fs.writeFileSync(arquivo, `${JSON.stringify(relatorio, null, 2)}\n`);
  console.log(JSON.stringify({ ...relatorio, registro: path.relative(process.cwd(), arquivo) }, null, 2));
  process.exitCode = relatorio.ok ? 0 : 1;
}

main().catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });
