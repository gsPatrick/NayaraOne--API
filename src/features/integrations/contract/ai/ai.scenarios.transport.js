'use strict';

const { TIMEOUT_JITTER_MS } = require('../contract.scenarios.transport');
const { requestOf, attempt, faultable, provoke, expectKind, result, shapeProblems } = require('./ai.runtime');

/** Cenários 1 a 6 da M9-D222 para os adapters de modelo (a operação recebe só o pedido e devolve o formato rico da M9-D010, não o normalizado do port). */

const naoValido = (op, r) => shapeProblems(op, r).join(', ');

async function auth({ make, fixture, ops }) {
  const out = [];
  for (const op of ops) {
    const { adapter } = make(null);
    const valida = await attempt(() => adapter[op](requestOf(fixture, op)));
    out.push(result(1, 'auth', op, valida.ok && shapeProblems(op, valida.value).length === 0, valida.ok ? `resposta fora da forma: ${naoValido(op, valida.value)}` : valida.error.message));
  }
  for (const op of faultable(fixture, ops)) {
    for (const [rotulo, fault] of [['inválida', { kind: 'status', status: 401 }], ['expirada', { kind: 'status', status: 401 }], ['recusada (403)', { kind: 'status', status: 403 }]]) {
      const { out: r } = await provoke({ make, fixture, op, fault, kind: 'AUTH' });
      const problema = expectKind(r, 'AUTH', false);
      out.push(result(1, 'auth', op, !problema, `credencial ${rotulo}: ${problema}`));
    }
  }
  if (fixture.transport === 'http') {
    for (const op of ops) {
      const { out: r } = await provoke({ make, fixture, op, fault: { kind: 'noSecret' }, kind: 'AUTH' });
      const problema = expectKind(r, 'AUTH', false) || (r.error.code === 'AI_PROVIDER_NOT_CONFIGURED' ? null : `código ${r.error.code}`);
      out.push(result(1, 'auth', op, !problema, `sem credencial no cofre: ${problema}`));
    }
  }
  const { adapter } = make(null);
  out.push(result(1, 'auth', null, fixture.renewal === false && typeof adapter.renewCredential !== 'function', 'a chave do modelo não renova e a fixture deve declarar renewal=false'));
  return out;
}

async function happyPath({ make, fixture, ops }) {
  const out = [];
  for (const op of ops) {
    const { adapter } = make(null);
    const r = await attempt(() => adapter[op](requestOf(fixture, op)));
    const problemas = r.ok ? shapeProblems(op, r.value) : [r.error.message];
    out.push(result(2, 'happy path', op, r.ok && problemas.length === 0, `resposta fora da forma: ${problemas.join(', ')}`));
  }
  return out;
}

async function timeout({ make, fixture, ops, timeoutMs }) {
  const out = [];
  for (const op of faultable(fixture, ops)) {
    const t0 = Date.now();
    const { out: r } = await provoke({ make, fixture, op, fault: { kind: 'timeout', afterMs: timeoutMs }, kind: 'TIMEOUT' });
    const ms = Date.now() - t0;
    const problema = expectKind(r, 'TIMEOUT', true);
    const noPrazo = fixture.transport !== 'http' || (ms >= timeoutMs * 0.8 && ms < timeoutMs + TIMEOUT_JITTER_MS);
    out.push(result(3, 'timeout', op, !problema && noPrazo, `${problema || 'fora do prazo'} (${ms} ms, prazo ${timeoutMs} ms)`));
  }
  return out;
}

async function client4xx({ make, fixture, ops }) {
  const out = [];
  for (const op of faultable(fixture, ops)) {
    for (const status of fixture.transport === 'http' ? [400, 404, 409, 422] : [400]) {
      const { out: r } = await provoke({ make, fixture, op, fault: { kind: 'status', status }, kind: 'VALIDATION' });
      const problema = expectKind(r, 'VALIDATION', false);
      out.push(result(4, '4xx', op, !problema, `HTTP ${status}: ${problema}`));
    }
  }
  return out;
}

async function server5xx({ make, fixture, ops }) {
  const out = [];
  for (const op of faultable(fixture, ops)) {
    for (const status of fixture.transport === 'http' ? [500, 502, 503, 504] : [503]) {
      const { out: r } = await provoke({ make, fixture, op, fault: { kind: 'status', status }, kind: 'UNAVAILABLE' });
      const problema = expectKind(r, 'UNAVAILABLE', true);
      out.push(result(5, '5xx', op, !problema, `HTTP ${status}: ${problema}`));
    }
  }
  return out;
}

async function rateLimit({ make, fixture, ops }) {
  const out = [];
  for (const op of faultable(fixture, ops)) {
    const { out: r } = await provoke({ make, fixture, op, fault: { kind: 'status', status: 429, retryAfter: 7 }, kind: 'RATE_LIMIT' });
    const problema = expectKind(r, 'RATE_LIMIT', true);
    const espera = fixture.transport !== 'http' || (r.error && r.error.details && r.error.details.retryAfterMs === 7000);
    out.push(result(6, 'rate limit', op, !problema && espera, `429 com Retry-After 7: ${problema || 'retryAfterMs diferente de 7000'}`));
  }
  return out;
}

module.exports = { auth, happyPath, timeout, client4xx, server5xx, rateLimit };
