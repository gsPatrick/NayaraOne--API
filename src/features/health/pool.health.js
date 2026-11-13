'use strict';

const { sequelize } = require('../../config/database');
const { estaEncerrando } = require('../../utils/processGuards');

/**
 * GET /api/health/pool — saúde do PROCESSO para o HEALTHCHECK do contêiner (rodada 8 da verificação do Marco 9, 12/11/2026; DI-M9R-23).
 *
 * O `GET /api/health` responde 200 sempre (informa `database: down` no corpo, de propósito: o painel de saúde não pode travar). Ele não serve para
 * reiniciar um processo vivo e preso: na rodada 8, com o pool de conexões esgotado por transações abandonadas, a API não atendia ninguém e nada a
 * reiniciava. Esta rota pede uma conexão ao pool e roda `SELECT 1`, com prazo `HEALTH_POOL_TIMEOUT_MS` (padrão 5.000 ms, faixa 500 a 60.000):
 * - 200 `{ status: 'ok', pool }` quando a conexão sai e responde no prazo;
 * - 503 `{ status: 'unhealthy', reason, pool }` quando não: `POOL_EXHAUSTED` (todas as conexões em uso e ninguém devolve), `DATABASE_UNREACHABLE`
 *   (o banco não respondeu) ou `SHUTTING_DOWN` (o processo está encerrando depois de uma falha fatal).
 * `pool` traz só contagens (máximo, abertas, livres, em uso, na fila). Nenhum dado de empresa, endereço ou credencial.
 */
const PADRAO_MS = 5000;
const FAIXA_MS = [500, 60000];

function prazoDaConferencia(env = process.env) {
  const n = Number(env.HEALTH_POOL_TIMEOUT_MS);
  if (env.HEALTH_POOL_TIMEOUT_MS === undefined || env.HEALTH_POOL_TIMEOUT_MS === '' || !Number.isInteger(n) || n < FAIXA_MS[0] || n > FAIXA_MS[1]) return PADRAO_MS;
  return n;
}

function contagens(db) {
  const pool = db.connectionManager && db.connectionManager.pool;
  if (!pool) return null;
  const alvo = pool.write || pool; // com réplicas o Sequelize separa leitura e escrita; aqui vale a de escrita
  return { max: alvo.maxSize, size: alvo.size, available: alvo.available, using: alvo.using, waiting: alvo.waiting };
}

/** Confere o pool: { ok, reason?, pool }. Nunca lança e nunca passa do prazo. */
async function conferirPool({ db = sequelize, timeoutMs = prazoDaConferencia() } = {}) {
  if (estaEncerrando()) return { ok: false, reason: 'SHUTTING_DOWN', pool: contagens(db) };
  let relogio;
  const prazo = new Promise((_, rejeita) => { relogio = setTimeout(() => rejeita(new Error('prazo')), timeoutMs); });
  try {
    await Promise.race([db.query('SELECT 1 AS ok'), prazo]);
    return { ok: true, pool: contagens(db) };
  } catch (_err) {
    const pool = contagens(db);
    const esgotado = pool && Number.isFinite(pool.max) && pool.using >= pool.max;
    return { ok: false, reason: esgotado ? 'POOL_EXHAUSTED' : 'DATABASE_UNREACHABLE', pool };
  } finally {
    clearTimeout(relogio);
  }
}

/** Handler da rota. */
const MENSAGENS = Object.freeze({
  POOL_EXHAUSTED: 'Todas as conexões com o banco estão em uso e nenhuma foi devolvida no prazo.',
  DATABASE_UNREACHABLE: 'O banco de dados não respondeu no prazo.',
  SHUTTING_DOWN: 'A API está encerrando para ser reiniciada.',
});

async function getPoolHealth(req, res) {
  const r = await conferirPool();
  res.set('Cache-Control', 'no-store');
  if (r.ok) return res.status(200).json({ success: true, data: { status: 'ok', pool: r.pool } });
  const traceId = req.correlationId || res.getHeader('X-Correlation-Id') || null;
  return res.status(503).json({ success: false, error: { code: r.reason, message: MENSAGENS[r.reason], traceId }, data: { status: 'unhealthy', reason: r.reason, pool: r.pool } });
}

module.exports = { conferirPool, getPoolHealth, prazoDaConferencia, PADRAO_MS, FAIXA_MS };
