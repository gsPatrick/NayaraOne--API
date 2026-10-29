'use strict';

/**
 * M9-D705 — ambiente dos comandos da esteira: valores públicos de CI (nenhum segredo real) e a trava de banco. Comando com `banco: true` só roda
 * em banco descartável em 127.0.0.1; nunca na homologação. Fora do descartável, o `run.js` se reexecuta dentro de `withDisposableDb.js`.
 */
const PADROES = Object.freeze({
  LOG_LEVEL: 'info',
  CI_TENANT_USERS_PASSWORD: 'ci-tenant-users-password-not-for-production',
  CLAMAV_HOST: '127.0.0.1',
  CLAMAV_PORT: '3310',
  NODE_ENV: 'test',
});

function bancoDescartavelAtivo(env = process.env) {
  if (env.DISPOSABLE_DB !== '1' || !env.DATABASE_URL) return false;
  try { return ['127.0.0.1', 'localhost'].includes(new URL(env.DATABASE_URL).hostname); } catch { return false; }
}

function ambienteDosComandos(env = process.env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(PADROES)) if (!out[k]) out[k] = v;
  return out;
}

function portaAleatoria() {
  return 55000 + Math.floor(Math.random() * 2000);
}

module.exports = { PADROES, bancoDescartavelAtivo, ambienteDosComandos, portaAleatoria };
