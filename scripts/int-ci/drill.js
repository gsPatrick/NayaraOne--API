#!/usr/bin/env node
'use strict';

/**
 * Failure drill do provider da tag (M9-D254, etapa 12): roda `scripts/failureDrill.js` (M9-D226) nos três cenários (provider-down, auth-failed, paused) em banco descartável
 * (o ensaio grava no banco e só aceita banco local). Provider em INT_CI_PROVIDER. Sai com 0 só se os três passaram; o relatório de cada um fica em docs/evidencias/contingencia.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CENARIOS = ['provider-down', 'auth-failed', 'paused'];
const RAIZ = path.join(__dirname, '..', '..');

const provider = process.env.INT_CI_PROVIDER;
if (!provider) { console.error('Informe INT_CI_PROVIDER (o provider da tag).'); process.exit(2); }
let falhou = false;
for (const cenario of CENARIOS) {
  const r = spawnSync('node', ['scripts/withDisposableDb.js', '--', 'node', 'scripts/failureDrill.js', provider, cenario], { cwd: RAIZ, stdio: 'inherit' });
  console.log(`${r.status === 0 ? 'OK ' : 'FALHA'} failure drill ${provider} ${cenario}`);
  falhou = falhou || r.status !== 0;
}
process.exit(falhou ? 1 : 0);
