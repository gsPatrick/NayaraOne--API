'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RAIZ_API } = require('./config');

const PORTA_MIN = 55000;
const PORTA_FAIXA = 2000;

/**
 * As provas de classificação, retenção e DLP precisam de banco descartável (nunca o compartilhado). Fora dele (DISPOSABLE_DB != 1) o fechamento sobe um cluster descartável
 * (scripts/withDisposableDb.js, porta aleatória), semeia os dois tenants do CI e executa a si mesmo lá dentro; o código de saída volta por um arquivo de status. Sem esse arquivo
 * (cluster que não subiu, processo morto) devolve 2: nunca "verde" por omissão.
 */
function reexecutarEmBancoDescartavel(argv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dod-f-status-'));
  const arquivoStatus = path.join(dir, 'status');
  const porta = process.env.GOV_CI_PORTA || String(PORTA_MIN + Math.floor(Math.random() * PORTA_FAIXA));
  try {
    spawnSync(process.execPath, [
      path.join(RAIZ_API, 'scripts', 'withDisposableDb.js'), '--port', porta, '--',
      'env', 'LOG_LEVEL=info', `CI_TENANT_USERS_PASSWORD=${process.env.CI_TENANT_USERS_PASSWORD || 'ci-tenant-users-password-not-for-production'}`,
      `CLAMAV_HOST=${process.env.CLAMAV_HOST || '127.0.0.1'}`, `CLAMAV_PORT=${process.env.CLAMAV_PORT || '3310'}`, `DOD_F_STATUS_FILE=${arquivoStatus}`,
      'bash', '-c', 'node scripts/seed-ci-two-tenants.js >/dev/null && exec node scripts/checkDodBlocoF.js "$@"', '_', ...argv,
    ], { cwd: RAIZ_API, stdio: 'inherit' });
    const lido = fs.existsSync(arquivoStatus) ? Number(fs.readFileSync(arquivoStatus, 'utf8').trim()) : NaN;
    return [0, 1, 2].includes(lido) ? lido : 2;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Dentro do banco descartável: grava o código de saída no arquivo combinado com quem subiu o cluster. */
function informarStatus(codigo) {
  if (process.env.DOD_F_STATUS_FILE) fs.writeFileSync(process.env.DOD_F_STATUS_FILE, String(codigo));
}

module.exports = { reexecutarEmBancoDescartavel, informarStatus };
