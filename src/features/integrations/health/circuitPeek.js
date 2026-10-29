'use strict';

const { resolveCircuitPolicy } = require('./circuitPolicyReader');
const { halfOpenFull } = require('./circuitMachine');
const { toView } = require('./circuitState');
const { findCurrentRow } = require('./healthStore');

/**
 * Leitura do circuito SEM mudar nada (M9-D223: o teste de saúde só lê e respeita o estado da M9-D217). Em CLOSED e OPEN o teste de
 * saúde roda (em OPEN é como se detecta a recuperação); em HALF_OPEN só roda se ainda houver vaga entre as `half_open_max_calls`
 * chamadas de teste. Nunca transiciona, nunca ocupa vaga.
 */
async function peekCircuit(connection, ctx, transaction, { now = new Date() } = {}) {
  const row = await findCurrentRow(connection.id, transaction);
  if (!row) return { allowed: true, state: 'CLOSED' };
  const view = toView(row);
  const policy = await resolveCircuitPolicy(ctx, connection, transaction);
  if (halfOpenFull(view, policy, now)) return { allowed: false, state: view.circuitState, reason: 'CIRCUIT_HALF_OPEN_FULL' };
  return { allowed: true, state: view.circuitState };
}

module.exports = { peekCircuit };
