'use strict';

/**
 * Trava do ensaio de falha (M9-D226 3.3 item 5): o ensaio GRAVA (conexão de laboratório, envios, tarefas) e por isso só roda contra banco LOCAL.
 * Lê o endereço do banco das variáveis de ambiente que o processo já recebeu (nunca abre o .env) e recusa tudo que não seja a própria máquina.
 */
const LOOPBACK = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostDoBanco(env) {
  if (env.DATABASE_URL) {
    try { return new URL(env.DATABASE_URL).hostname; } catch { return null; }
  }
  return env.DB_HOST || null;
}

/** Devolve { ok, host }. Sem endereço informado também é recusado: sem certeza de que é local, não roda. */
function checkLocalDatabase(env = process.env) {
  const host = hostDoBanco(env);
  return { ok: host !== null && LOOPBACK.includes(String(host).toLowerCase()), host: host ? 'definido' : 'não definido' };
}

module.exports = { checkLocalDatabase, hostDoBanco, LOOPBACK };
