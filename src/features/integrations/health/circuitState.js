'use strict';

const AppError = require('../../../utils/AppError');
const { loadConnection, loadHealthContext, statusOf } = require('./healthContext');
const { findCurrentRow, ensureCurrentRow, writeStatus, q, SELECT } = require('./healthStore');

/**
 * Estado do circuit breaker persistido em provider_health (M9-D206 regra 3.2.2): sobrevive a reinício e vale para
 * todas as instâncias. A lógica das transições é da M9-D217; aqui só se lê (com cache de memória de 2 s) e se grava
 * de forma atômica (`UPDATE ... WHERE connection_id`, incrementos no próprio SQL).
 */
const CACHE_TTL_MS = 2000;
const STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'];
const FIELDS = {
  circuitState: 'circuit_state', circuitOpenedAt: 'circuit_opened_at', circuitCooldownS: 'circuit_cooldown_s',
  consecutiveFailures: 'consecutive_failures', halfOpenSuccesses: 'half_open_successes',
};
const cache = new Map();

const clearCircuitCache = () => cache.clear();

const toView = (row) => ({
  circuitState: row ? row.circuit_state : 'CLOSED',
  circuitOpenedAt: row ? row.circuit_opened_at : null,
  circuitCooldownS: row ? row.circuit_cooldown_s : null,
  consecutiveFailures: row ? row.consecutive_failures : 0,
  halfOpenSuccesses: row ? row.half_open_successes : 0,
});

/** Lê o circuito. Sem linha atual o circuito é CLOSED (connection inexistente ou de outra empresa: 404). */
async function readCircuitState(connectionId, ctx, transaction, { now = new Date(), fresh = false } = {}) {
  const key = `${ctx.companyId}:${connectionId}`;
  const hit = cache.get(key);
  if (!fresh && hit && now.getTime() - hit.at.getTime() < CACHE_TTL_MS && now.getTime() >= hit.at.getTime()) return hit.view;
  const row = await findCurrentRow(connectionId, transaction);
  if (!row) await loadConnection(connectionId, transaction);
  const view = toView(row);
  cache.set(key, { view, at: now });
  return view;
}

function buildSet(patch) {
  const sets = [];
  const rep = {};
  Object.entries(patch).forEach(([campo, valor], i) => {
    const coluna = FIELDS[campo];
    if (!coluna) throw AppError.badRequest(`Campo de circuito desconhecido: ${campo}.`, 'INTEGRATION_CIRCUIT_FIELD_INVALID');
    if (campo === 'circuitState' && !STATES.includes(valor)) {
      throw AppError.badRequest('Estado de circuito inválido.', 'INTEGRATION_CIRCUIT_STATE_INVALID');
    }
    if (valor && typeof valor === 'object' && !(valor instanceof Date)) {
      const inc = Number(valor.inc);
      if (!Number.isInteger(inc) || campo === 'circuitState' || campo === 'circuitOpenedAt') {
        throw AppError.badRequest(`Incremento inválido para ${campo}.`, 'INTEGRATION_CIRCUIT_FIELD_INVALID');
      }
      sets.push(`${coluna} = GREATEST(${coluna} + :v${i}, 0)`);
      rep[`v${i}`] = inc;
    } else {
      sets.push(`${coluna} = :v${i}`);
      rep[`v${i}`] = valor ?? null;
    }
  });
  return { sets, rep };
}

/**
 * Grava o circuito de forma atômica e recalcula o estado de saúde. `patch`: campos de FIELDS; um número é
 * atribuído, `{ inc: n }` soma no banco (sem ler antes). Devolve o circuito vigente.
 */
async function updateCircuitState(connectionId, patch, transaction, { now = new Date() } = {}) {
  const { sets, rep } = buildSet(patch);
  const connection = await loadConnection(connectionId, transaction);
  await ensureCurrentRow(connection, now, transaction);
  const rows = sets.length === 0 ? [await findCurrentRow(connectionId, transaction)] : await q(
    `UPDATE "integration"."provider_health" SET ${sets.join(', ')}, updated_at = :now
     WHERE connection_id = :id AND window_minutes = 0 RETURNING *`,
    { ...rep, id: connectionId, now },
    transaction,
    SELECT,
  );
  const healthCtx = await loadHealthContext(connection, transaction);
  const row = await writeStatus(connectionId, statusOf(rows[0], healthCtx, now), now, transaction);
  const view = toView(row);
  cache.set(`${connection.companyId}:${connectionId}`, { view, at: now });
  return view;
}

module.exports = { readCircuitState, updateCircuitState, clearCircuitCache, CACHE_TTL_MS };
