#!/usr/bin/env node
'use strict';

/**
 * Ensaio de falha da contingência de um fornecedor de laboratório (Marco 9, M9-D226 3.3 item 5).
 *   node scripts/failureDrill.js <provider> <cenario> [--company <uuid>] [--out <pasta>]
 *   ex.: node scripts/withDisposableDb.js -- node scripts/failureDrill.js messaging-sandbox provider-down
 * Cenários: provider-down, auth-failed, paused. Derruba o sandbox, valida a ativação da contingência, a tarefa manual do que venceu na fila e a recuperação,
 * e grava o relatório (JSON) em docs/evidencias/contingencia. GRAVA no banco: roda só contra banco LOCAL (a trava recusa qualquer outro endereço e este
 * script nunca lê o .env). Saída 0 = ensaio aprovado; 1 = reprovado; 2 = uso incorreto ou banco não local.
 */
const { checkLocalDatabase } = require('../src/features/integrations/contingency/drill/drill.guard');

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--company') opts.company = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else pos.push(argv[i]);
  }
  return { provider: pos[0], scenario: pos[1], ...opts };
}

async function main() {
  const { provider, scenario, company, out } = parseArgs(process.argv.slice(2));
  if (!provider || !scenario) {
    console.error('Uso: node scripts/failureDrill.js <provider> <cenario> [--company <uuid>] [--out <pasta>]');
    return 2;
  }
  const guarda = checkLocalDatabase(process.env);
  if (!guarda.ok) {
    console.error('Recusado: o ensaio grava no banco e só roda contra banco local (127.0.0.1). Use: node scripts/withDisposableDb.js -- node scripts/failureDrill.js ...');
    return 2;
  }
  const { runFailureDrill } = require('../src/features/integrations/contingency/drill/drill.run');
  const { sequelize } = require('../src/models');
  try {
    const { report, file } = await runFailureDrill({ provider, scenario, companyId: company || null, ...(out ? { outDir: out } : {}) });
    report.steps.forEach((s) => console.log(`${s.ok ? 'OK ' : 'FALHA'} ${s.name}${s.detail ? ` ${JSON.stringify(s.detail)}` : ''}`));
    console.log(`Relatório: ${file}`);
    console.log(report.passed ? 'ENSAIO APROVADO' : 'ENSAIO REPROVADO');
    return report.passed ? 0 : 1;
  } finally {
    await sequelize.close();
  }
}

main().then((code) => process.exit(code)).catch((err) => { console.error(`Falha do ensaio: ${err.message}`); process.exit(1); });
