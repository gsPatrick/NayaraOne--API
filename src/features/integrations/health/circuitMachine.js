'use strict';

const { CLASSES_QUE_CONTAM } = require('./circuitPolicy');

/**
 * Máquina de estados do circuit breaker (M9-D217 seção 3.1), pura: recebe a linha do circuito, a política e o instante e devolve
 * a decisão e o que gravar (`patch`, com os nomes de updateCircuitState). Sem banco, sem relógio, sem número de limiar.
 *
 *   CLOSED --(falhas consecutivas >= failure_threshold)--> OPEN --(cooldown vencido)--> HALF_OPEN --(sucesso)--> CLOSED
 *   HALF_OPEN --(falha)--> OPEN
 *
 * Qualquer outra transição é bug: nenhuma função abaixo troca de estado fora dessas quatro setas.
 * `row`: { circuitState, circuitOpenedAt, circuitCooldownS, consecutiveFailures, halfOpenSuccesses, halfOpenInflight, halfOpenInflightSince }.
 */
const ms = (d) => (d ? new Date(d).getTime() : null);
const cooldownMs = (row, policy) => (Number.isInteger(row.circuitCooldownS) ? row.circuitCooldownS : policy.cooldown_s) * 1000;

/** Instante em que o cooldown vence (null se o circuito aberto não tem a data de abertura). */
function cooldownEnd(row, policy) {
  const abertoEm = ms(row.circuitOpenedAt);
  return abertoEm === null ? null : abertoEm + cooldownMs(row, policy);
}

const openPatch = (policy, now) => ({
  circuitState: 'OPEN', circuitOpenedAt: now, circuitCooldownS: policy.cooldown_s, halfOpenSuccesses: 0, halfOpenInflight: 0, halfOpenInflightSince: null,
});
const closePatch = () => ({
  circuitState: 'CLOSED', circuitOpenedAt: null, circuitCooldownS: null, consecutiveFailures: 0, halfOpenSuccesses: 0, halfOpenInflight: 0, halfOpenInflightSince: null,
});

/**
 * Admissão no HALF_OPEN: até half_open_max_calls testes ao mesmo tempo. A vaga presa por um processo que caiu antes de devolver o
 * resultado é liberada passado o cooldown (senão o circuito nunca mais fecharia).
 */
function inflightNow(row, policy, now) {
  const preso = row.halfOpenInflight > 0 && ms(row.halfOpenInflightSince) !== null && now.getTime() - ms(row.halfOpenInflightSince) > cooldownMs(row, policy);
  return { preso, emVoo: preso ? 0 : row.halfOpenInflight };
}

/** As vagas de teste do HALF_OPEN estão todas ocupadas? (leitura pura, para o health check respeitar o limite sem ocupar vaga) */
const halfOpenFull = (row, policy, now) => row.circuitState === 'HALF_OPEN' && inflightNow(row, policy, now).emVoo >= policy.half_open_max_calls;

function admitHalfOpen(row, policy, now, base = {}) {
  const { preso, emVoo } = inflightNow(row, policy, now);
  if (emVoo < policy.half_open_max_calls) {
    return {
      decision: 'ALLOW', probe: true, state: 'HALF_OPEN',
      patch: { ...base, halfOpenInflight: emVoo + 1, halfOpenInflightSince: emVoo === 0 ? now : row.halfOpenInflightSince },
    };
  }
  return {
    decision: 'DENY', probe: false, state: 'HALF_OPEN', reason: 'CIRCUIT_HALF_OPEN_FULL', until: new Date(now.getTime() + policy.recheck_s * 1000), patch: preso ? { ...base, halfOpenInflight: 0 } : base,
  };
}

/**
 * Antes de uma chamada: pode sair? `essential` (definido por operação no port) atravessa o circuito aberto; as demais esperam o cooldown.
 * Devolve { decision: 'ALLOW'|'DENY', probe, state, reason?, until?, patch, transition? }.
 */
function evaluateAdmission(row, policy, { essential = false, now = new Date() } = {}) {
  if (row.circuitState === 'CLOSED') return { decision: 'ALLOW', probe: false, state: 'CLOSED', patch: {} };
  if (row.circuitState === 'OPEN') {
    const fim = cooldownEnd(row, policy);
    if (fim !== null && now.getTime() >= fim) {
      const r = admitHalfOpen({ ...row, halfOpenInflight: 0, halfOpenInflightSince: null }, policy, now, { circuitState: 'HALF_OPEN', halfOpenSuccesses: 0 });
      return { ...r, transition: 'HALF_OPEN' };
    }
    if (essential) return { decision: 'ALLOW', probe: false, state: 'OPEN', patch: {} };
    return { decision: 'DENY', probe: false, state: 'OPEN', reason: 'CIRCUIT_OPEN', until: new Date(fim !== null ? fim : now.getTime() + policy.recheck_s * 1000), patch: {} };
  }
  return admitHalfOpen(row, policy, now);
}

/** A falha conta para o circuito? Só TRANSIENT e UNKNOWN: o resto é dado nosso, limite do fornecedor (D218) ou credencial (D216). */
const countsAsFailure = (errorClass) => CLASSES_QUE_CONTAM.includes(errorClass);

/** Devolve uma vaga de teste (a chamada voltou), sem passar de zero. */
const release = (row) => ({ halfOpenInflight: Math.max(row.halfOpenInflight - 1, 0), halfOpenInflightSince: row.halfOpenInflight > 1 ? row.halfOpenInflightSince : null });

/**
 * Depois da chamada: { ok, errorClass, probe }. `probe` diz que a chamada ocupou uma vaga de teste do HALF_OPEN.
 * Devolve { patch, transition?, opened?, closed? }.
 */
function evaluateResult(row, policy, { ok = false, errorClass = null, probe = false, now = new Date() } = {}) {
  if (row.circuitState === 'CLOSED') {
    if (ok) return { patch: row.consecutiveFailures > 0 ? { consecutiveFailures: 0 } : {} };
    if (!countsAsFailure(errorClass)) return { patch: {} };
    const falhas = row.consecutiveFailures + 1;
    if (falhas >= policy.failure_threshold) return { patch: { ...openPatch(policy, now), consecutiveFailures: falhas }, transition: 'OPEN', opened: true };
    return { patch: { consecutiveFailures: falhas } };
  }
  if (row.circuitState === 'HALF_OPEN' && probe) {
    const liberada = release(row);
    if (ok) {
      const sucessos = row.halfOpenSuccesses + 1;
      if (sucessos >= policy.close_after_successes) return { patch: closePatch(), transition: 'CLOSED', closed: true };
      return { patch: { ...liberada, halfOpenSuccesses: sucessos } };
    }
    if (countsAsFailure(errorClass)) return { patch: { ...openPatch(policy, now), consecutiveFailures: row.consecutiveFailures + 1 }, transition: 'OPEN', opened: true };
    return { patch: liberada };
  }
  // Chamada que começou em outro estado (ou essencial que atravessou o OPEN): não decide nada, só devolve a vaga se tinha uma.
  return { patch: probe && row.halfOpenInflight > 0 ? release(row) : {} };
}

module.exports = { evaluateAdmission, evaluateResult, countsAsFailure, cooldownEnd, halfOpenFull };
