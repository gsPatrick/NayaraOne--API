'use strict';

const { withWire, BEFORE } = require('./contract.wire');
const { callOp, classifyFailure, attempt, result, opClassOf } = require('./contract.runtime');

/** Folga absoluta além do prazo para a máquina ocupada (CI, desenvolvimento paralelo): o adapter precisa desistir NO prazo, não em 1,9 vezes dele (prazo de 40 ms estourava em 76 ms sob carga). */
const TIMEOUT_JITTER_MS = 1500;

/** Cenários 1 a 6 (M9-D222 3.1): auth, happy path, timeout, 4xx, 5xx e rate limit. Cada função recebe { adapter, fixture, ops, state, timeoutMs } e devolve a lista de resultados. */

async function auth({ adapter, fixture, ops, state }) {
  const out = [];
  for (const op of ops) {
    const valida = await attempt(() => callOp(adapter, fixture, op, state));
    out.push(result(1, 'auth', op, valida.ok, `credencial válida deveria passar: ${valida.error && valida.error.message}`));
    for (const [rotulo, falha] of [['inválida', BEFORE.auth()], ['expirada', BEFORE.expiredToken()]]) {
      const r = await attempt(() => callOp(withWire(adapter, op, { before: falha }), fixture, op, {}));
      const classe = r.ok ? null : classifyFailure(adapter, r.error, op).class;
      out.push(result(1, 'auth', op, classe === 'AUTH', `credencial ${rotulo}: esperado AUTH, veio ${classe}`));
    }
    const renova = typeof adapter.renewCredential === 'function';
    if (renova) {
      const r = await attempt(() => adapter.renewCredential(adapter.ctx));
      out.push(result(1, 'auth', op, r.ok, 'a renovação da credencial falhou'));
    } else out.push(result(1, 'auth', op, fixture.renewal === false, 'o adapter não renova credencial e a fixture não declara renewal=false'));
  }
  return out;
}

async function happyPath({ adapter, fixture, ops, state }) {
  const out = [];
  for (const op of ops) {
    const r = await attempt(() => callOp(adapter, fixture, op, state, { tenant: null }));
    const semId = (fixture.noResourceId || []).includes(op);
    const ok = r.ok && typeof r.value.status === 'string' && r.value.status.length > 0 && (semId || (typeof r.value.externalResourceId === 'string' && r.value.externalResourceId.length > 0));
    out.push(result(2, 'happy path', op, ok, r.ok ? `resposta sem status ou sem externalResourceId: ${JSON.stringify(Object.keys(r.value))}` : r.error.message));
  }
  return out;
}

async function timeout({ adapter, fixture, ops, timeoutMs }) {
  const out = [];
  for (const op of ops) {
    const t0 = Date.now();
    const r = await attempt(() => callOp(withWire(adapter, op, { before: BEFORE.timeout(timeoutMs) }), fixture, op, {}));
    const ms = Date.now() - t0;
    const classe = r.ok ? null : classifyFailure(adapter, r.error, op).class;
    const esperado = opClassOf(adapter, op) === 'DANGEROUS' ? 'UNKNOWN' : 'TRANSIENT';
    out.push(result(3, 'timeout', op, classe === esperado && ms >= timeoutMs * 0.8 && ms < timeoutMs + TIMEOUT_JITTER_MS, `esperado ${esperado} em ~${timeoutMs} ms; veio ${classe} em ${ms} ms`));
  }
  return out;
}

async function client4xx({ adapter, fixture, ops }) {
  const out = [];
  for (const op of ops) {
    for (const status of [400, 404, 409, 422]) {
      const r = await attempt(() => callOp(withWire(adapter, op, { before: BEFORE.http(status) }), fixture, op, {}));
      const c = r.ok ? null : classifyFailure(adapter, r.error, op);
      const limpa = r.ok ? false : !/(token|senha|secret|bearer)\s*[=:]/i.test(r.error.message);
      out.push(result(4, '4xx', op, c && c.class === 'VALIDATION' && limpa, `HTTP ${status}: esperado VALIDATION sem segredo, veio ${c && c.class}`));
    }
  }
  return out;
}

async function server5xx({ adapter, fixture, ops }) {
  const out = [];
  for (const op of ops) {
    const esperado = opClassOf(adapter, op) === 'SAFE' || adapter.supportsIdempotency(op) ? 'TRANSIENT' : 'UNKNOWN';
    for (const status of [500, 502, 503, 504]) {
      const r = await attempt(() => callOp(withWire(adapter, op, { before: BEFORE.http(status) }), fixture, op, {}));
      const c = r.ok ? null : classifyFailure(adapter, r.error, op);
      out.push(result(5, '5xx', op, c && c.class === esperado, `HTTP ${status}: esperado ${esperado} (${opClassOf(adapter, op)}, idempotente=${adapter.supportsIdempotency(op)}), veio ${c && c.class}`));
    }
  }
  return out;
}

async function rateLimit({ adapter, fixture, ops }) {
  const out = [];
  for (const op of ops) {
    const r = await attempt(() => callOp(withWire(adapter, op, { before: BEFORE.rateLimit(7) }), fixture, op, {}));
    const c = r.ok ? null : classifyFailure(adapter, r.error, op);
    out.push(result(6, 'rate limit', op, c && c.class === 'RATE_LIMIT' && c.retryAfterMs === 7000, `429 com Retry-After 7: esperado RATE_LIMIT com 7000 ms, veio ${c && c.class} ${c && c.retryAfterMs}`));
  }
  return out;
}

module.exports = { auth, happyPath, timeout, client4xx, server5xx, rateLimit, TIMEOUT_JITTER_MS };
