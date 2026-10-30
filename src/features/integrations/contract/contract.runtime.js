'use strict';

const { classifyDispatchError } = require('../dispatch/retry/retry.classify');
const { invoke } = require('../registry/adapterInvoke');
const { doubleMeta } = require('./doubles');

/** Contexto do adapter nos contract tests: connection de laboratório, prazos curtos da política e leitor de segredo falso (nenhum segredo real). */
function buildContext({ providerCode, version, timeoutMs, healthTimeoutMs, config = {} }) {
  return Object.freeze({
    connection: Object.freeze({ id: `contract-${providerCode}`, providerCode, environment: 'SANDBOX', apiVersion: version, config }),
    policy: {},
    timeouts: { readMs: timeoutMs, writeMs: timeoutMs },
    healthCheckTimeoutMs: healthTimeoutMs,
    secret: async () => 'segredo-de-contrato-nao-real',
  });
}

let contador = 0;
const nextKey = (rotulo) => `contract-${rotulo}-${(contador += 1)}`;

const opDef = (adapter, op) => adapter.constructor.operations[op];
const opClassOf = (adapter, op) => opDef(adapter, op).opClass;

/**
 * Chamada de uma capability pelo contrato do port (`invoke`: valida pedido e resposta normalizada). O pedido vem da fixture; se ele depende do recurso criado por outra
 * operação (`externalResourceIdFrom`), a outra roda antes (com chave própria). Devolve a resposta normalizada.
 */
async function callOp(adapter, fixture, op, state, { key = nextKey(op), tenant = null } = {}) {
  const extraMeta = doubleMeta(fixture.legacyDouble);
  const modelo = fixture.requests[op];
  const pedido = { ...modelo };
  if (modelo.externalResourceIdFrom) {
    delete pedido.externalResourceIdFrom;
    if (!state[modelo.externalResourceIdFrom]) {
      const origem = await callOp(adapter, fixture, modelo.externalResourceIdFrom, state, { key: nextKey(`${op}-origem`) });
      state[modelo.externalResourceIdFrom] = origem;
    }
    pedido.externalResourceId = state[modelo.externalResourceIdFrom].externalResourceId;
  }
  // Duplo do fluxo manual: empresa e transação de mentira que o adapter exige (vale também para os cenários de falha).
  return invoke(adapter, op, pedido, { tenant, meta: { idempotencyKey: key, ...(extraMeta || {}) } });
}

/** Classe do erro como o Dispatch Service decide: o `classifyError` do adapter mais a tabela única da M9-D216. */
function classifyFailure(adapter, error, op) {
  const idempotent = adapter.supportsIdempotency(op);
  return classifyDispatchError(error, adapter.classifyError(error), { opClass: opClassOf(adapter, op), idempotent });
}

/** Roda `fn`; devolve { ok:true, value } ou { ok:false, error } (nunca lança). */
async function attempt(fn) {
  try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; }
}

const result = (scenario, name, capability, ok, detail) => ({ scenario, name, capability: capability || null, ok: Boolean(ok), detail: ok ? null : String(detail).slice(0, 300) });

module.exports = { buildContext, callOp, classifyFailure, attempt, result, opClassOf, opDef, nextKey };
