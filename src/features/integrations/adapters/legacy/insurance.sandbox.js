'use strict';

const { OPS } = require('./insurance.ops');

/**
 * Estado do sandbox de seguro (M9-D238), em memória como o dos outros sandboxes: a proposta aceita por chave de idempotência (a mesma chave devolve a mesma apólice, sem emitir
 * outra) e a falha que o laboratório injeta na connection (`config.sandbox_fault`): TIMEOUT_AFTER_SEND (a seguradora grava a proposta e a resposta se perde, uma vez por chave),
 * HTTP_401 e HTTP_503. `calls.propose` conta as emissões que de fato chegaram à seguradora.
 */
const PROPOSED = new Map();
const FAULTS_USED = new Set();
const calls = { propose: 0 };

const erroHttp = (status, message) => Object.assign(new Error(message), { status });
const keyOf = (self, chave) => `${self.ctx.connection.id}|${chave}`;
const faultOf = (self) => (self.ctx.connection.config || {}).sandbox_fault;

function failFast(self) {
  const fault = faultOf(self);
  if (fault === 'HTTP_401') throw erroHttp(401, 'Credencial recusada');
  if (fault === 'HTTP_503') throw erroHttp(503, 'Seguradora indisponível');
}

/** Operações do sandbox: as comuns, com a proposta idempotente pela chave e as falhas injetáveis. */
const SANDBOX_OPS = Object.freeze({
  ...OPS,
  quote: async (l, req, self, meta) => { failFast(self); return OPS.quote(l, req, self, meta); },
  propose: async (l, req, self, meta) => {
    failFast(self);
    const k = keyOf(self, (meta && meta.idempotencyKey) || req.idempotencyKey || 'sem-chave');
    let resposta = PROPOSED.get(k);
    if (!resposta) {
      resposta = await OPS.propose(l, req, self, meta);
      PROPOSED.set(k, resposta);
      calls.propose += 1;
    }
    if (faultOf(self) === 'TIMEOUT_AFTER_SEND' && !FAULTS_USED.has(k)) {
      FAULTS_USED.add(k);
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    }
    return resposta;
  },
});

/** Consulta pela chave (M9-D215): o sandbox lembra as propostas aceitas; sem registro, a proposta pode sair de novo com a MESMA chave. */
const findByIdempotencyKey = async (_legacy, req, self) => {
  const r = PROPOSED.get(keyOf(self, req.idempotencyKey));
  return r ? { found: true, externalResourceId: r.externalResourceId, status: 'ACTIVE' } : { found: false };
};

const resetSandbox = () => { PROPOSED.clear(); FAULTS_USED.clear(); calls.propose = 0; };

module.exports = { SANDBOX_OPS, findByIdempotencyKey, calls, resetSandbox };
