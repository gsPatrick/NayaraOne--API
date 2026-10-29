'use strict';

const { defaultCircuitPolicy } = require('./circuitPolicy');
const { evaluateAdmission, evaluateResult } = require('./circuitMachine');
const { circuitOpen } = require('./circuit.errors');

/**
 * Circuito de quem chama o fornecedor SEM connection (Seguro, via utils/resilientFetch): a mesma máquina de estados e a política
 * padrão do livro, com o estado guardado no processo (não há linha em provider_health sem connection). Chamadas com connection
 * não passam por aqui: o circuito delas é o persistido, decidido pelo Dispatch Service.
 */
const estados = new Map();

const novo = () => ({
  circuitState: 'CLOSED', circuitOpenedAt: null, circuitCooldownS: null, consecutiveFailures: 0, halfOpenSuccesses: 0, halfOpenInflight: 0, halfOpenInflightSince: null,
});
const linhaDe = (key) => {
  if (!estados.has(key)) estados.set(key, novo());
  return estados.get(key);
};
const aplica = (row, patch) => Object.assign(row, patch);

/** Admite a chamada ou lança 503 INTEGRATION_CIRCUIT_OPEN. Devolve { probe }. */
function admit(circuitKey, { now = new Date() } = {}) {
  const row = linhaDe(circuitKey);
  const r = evaluateAdmission(row, defaultCircuitPolicy(), { essential: false, now });
  aplica(row, r.patch);
  if (r.decision !== 'ALLOW') throw circuitOpen({ ...r, circuitKey });
  return { probe: r.probe };
}

/** Resultado da chamada: errorClass TRANSIENT/UNKNOWN conta como falha, o resto não. */
function record(circuitKey, { ok, errorClass = null, probe = false, now = new Date() }) {
  const row = linhaDe(circuitKey);
  aplica(row, evaluateResult(row, defaultCircuitPolicy(), { ok, errorClass, probe, now }).patch);
}

const resetCircuitGates = () => estados.clear();

module.exports = { admit, record, resetCircuitGates };
