'use strict';

const { result } = require('../contract.runtime');
const { shapeProblems, isNormalized } = require('./ai.shapes');
const { SEGREDO_DE_CONTRATO } = require('./ai.context');

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Pedido da fixture; com `marker` (sandbox, que falha por marcador no texto) o marcador entra no último texto do usuário. */
function requestOf(fixture, op, marker) {
  const pedido = clone(fixture.requests[op]);
  if (marker && Array.isArray(pedido.messages) && pedido.messages.length) {
    const ultimo = pedido.messages[pedido.messages.length - 1];
    ultimo.content = `${ultimo.content} ${marker}`;
  }
  return pedido;
}

const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; } };

/** Operações em que a falha pode ser injetada: todas no adapter real (HTTP falso); no sandbox, só as que leem marcador. */
const faultable = (fixture, ops) => (fixture.transport === 'http' ? ops : ops.filter((o) => (fixture.faultOps || []).includes(o)));

/**
 * Um pedido sob falha: no adapter real a falha entra no HTTP falso (`fault`); no sandbox entra como marcador (`fixture.markers[kind]`). `kind` é o tipo de erro normalizado esperado
 * (AUTH, VALIDATION, RATE_LIMIT, UNAVAILABLE, TIMEOUT). Devolve { out, calls } (out = { ok } ou { ok:false, error }).
 */
async function provoke({ make, fixture, op, fault, kind }) {
  const { adapter, calls } = make(fixture.transport === 'http' ? fault : null);
  const marker = fixture.transport === 'http' ? null : (fixture.markers || {})[kind];
  const out = await attempt(() => adapter[op](requestOf(fixture, op, marker)));
  return { out, calls };
}

/** Confere o erro normalizado: tipo, se repetir adianta e nenhum segredo no erro. Devolve o texto do problema ou null. */
function expectKind(out, kind, retryable) {
  if (out.ok) return `esperado ${kind}, mas a chamada teve sucesso`;
  const e = out.error;
  if (!isNormalized(e)) return `erro não normalizado: ${e && e.constructor && e.constructor.name}`;
  if (e.kind !== kind) return `esperado ${kind}, veio ${e.kind}`;
  if (e.retryable !== retryable) return `${kind}: retryable deveria ser ${retryable}`;
  if (JSON.stringify({ m: e.message, d: e.details }).includes(SEGREDO_DE_CONTRATO)) return 'o erro carrega a credencial';
  return null;
}

module.exports = { requestOf, attempt, faultable, provoke, expectKind, result, shapeProblems, isNormalized };
