'use strict';

const { dbNotDisposable } = require('./contract.errors');

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_e) { return null; }
}

/**
 * O contract test cria dados de verdade e só roda no cluster descartável (M9-D842 §3.4 e §6): DISPOSABLE_DB=1 e as duas conexões (runtime e administrador do cluster) em 127.0.0.1.
 * Devolve o motivo da recusa (achado) ou null. Nunca imprime a conexão.
 */
function disposableProblem(env = process.env) {
  if (env.DISPOSABLE_DB !== '1') return dbNotDisposable('use `npm run test:contract` (scripts/withDisposableDb.js); DISPOSABLE_DB não está ligado');
  for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL']) {
    const host = hostOf(env[name]);
    if (!host) return dbNotDisposable(`${name} ausente ou inválida`);
    if (!LOCAL_HOSTS.includes(host)) return dbNotDisposable(`${name} não aponta para 127.0.0.1`);
  }
  return null;
}

/** Lança o erro de banco compartilhado (para o comando e para o início da suíte). */
function assertDisposable(env = process.env) {
  const problem = disposableProblem(env);
  if (problem) throw Object.assign(new Error(problem.message), { code: problem.code, details: problem.details });
}

module.exports = { disposableProblem, assertDisposable };
