#!/usr/bin/env node
'use strict';

/**
 * Execução offline da suíte da NAY (M9-D047): roda TODA a test/marco9/ia/ (mais os testes de fora dela que provam itens do DoD) contra o provider sandbox, com JUnit e
 * com o registro de conexões externas, e consolida reports/offline-run-ia.json (testes, estado de cada um, 0 chamadas externas). É o relatório que a autochecagem
 * (M9-D258, escopo ia-nay) e o DoD (scripts/ai-dod-check.js) leem. Último comando do estágio 12 da esteira (scripts/ai-ci/estagios.json); só roda em banco descartável.
 * Uso: node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && node scripts/ai-ci/offlineIa.js"
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { carregar } = require('../ai-dod/lib/matriz');
const L = require('./lib/offlineIa');

const RAIZ = path.resolve(__dirname, '..', '..');

if (process.env.DISPOSABLE_DB !== '1') {
  console.error('RECUSADO: a execução offline da suíte da NAY só roda em banco descartável (node scripts/withDisposableDb.js -- ...).');
  process.exit(2);
}
fs.rmSync(path.join(RAIZ, L.PASTA_JUNIT), { recursive: true, force: true });
fs.mkdirSync(path.join(RAIZ, L.PASTA_JUNIT), { recursive: true });
const arquivos = L.arquivosDaExecucao(RAIZ, carregar());
const { argv, env } = L.comandoDaExecucao(arquivos);
console.log(`$ node --test (${arquivos.length} arquivos de teste da NAY, offline)`);
const suite = spawnSync(argv[0], argv.slice(1), { cwd: RAIZ, stdio: 'inherit', env: { ...process.env, ...env } });
// O relatório sai mesmo com teste vermelho: ele é a prova do que ficou vermelho. O código de saída da esteira vem do `node --test`.
const rel = L.comandoDoRelatorio();
const consolidado = spawnSync(rel[0], rel.slice(1), { cwd: RAIZ, stdio: 'inherit' });
process.exit(suite.status === 0 && consolidado.status === 0 ? 0 : 1);
