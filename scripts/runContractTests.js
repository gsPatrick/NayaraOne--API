#!/usr/bin/env node
'use strict';
/**
 * Comando do contract test (M9-D842): `npm run test:contract` (sobe o cluster descartável com scripts/withDisposableDb.js, semeia os dois tenants e chama este arquivo).
 * Recusa rodar fora do banco descartável (exit 2, GOV_CONTRACT_DB_NOT_DISPOSABLE) ANTES de carregar qualquer configuração; nunca imprime a conexão.
 * Saída: 0 suíte verde; 1 suíte vermelha; 2 banco compartilhado. Relatórios (JSON e JUnit) em CONTRACT_REPORT_DIR (padrão docs/evidencias/ci).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { disposableProblem } = require('../src/features/core-governance/api-governance/contract/contract.guard');

const problem = disposableProblem(process.env);
if (problem) {
  console.error(`${problem.code} ${problem.message}`);
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'test/marco9/governanca');
const files = fs.readdirSync(dir).filter((name) => /^m9d842\..+\.test\.js$/.test(name)).sort().map((name) => path.join(dir, name));
const reportDir = path.resolve(root, process.env.CONTRACT_REPORT_DIR || 'docs/evidencias/ci');
fs.mkdirSync(reportDir, { recursive: true });
const args = ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${path.join(reportDir, 'contract-tests.junit.xml')}`, ...files];
const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', CONTRACT_REPORT_DIR: reportDir } });
process.exit(run.status === null ? 1 : run.status);
