'use strict';

const { invoke } = require('../../registry/adapterInvoke');
const { enrichFor } = require('./reconcile.enrichers');

/** Resultado de cada consulta. O motor só chama de "não existe" o que o fornecedor afirma com certeza. */
const FOUND = 'FOUND';
const NOT_FOUND = 'NOT_FOUND';
const ERROR = 'ERROR';

const httpStatusOf = (e) => Number(e && (e.status ?? e.statusCode ?? e.details?.status ?? e.response?.status));
const isNotFound = (e) => Boolean(e) && (e.notFound === true || httpStatusOf(e) === 404);
const codeOf = (e) => String((e && (e.code || (httpStatusOf(e) ? `HTTP_${httpStatusOf(e)}` : e.name))) || 'ERROR').slice(0, 64);

/** O que o fornecedor devolveu para o recurso achado: status interno (mapStatus do adapter) e ids; sem status mapeável a consulta é inconclusiva. */
function toFound(adapter, answer) {
  const bruto = answer && answer.status;
  if (typeof bruto !== 'string' || !bruto) return { outcome: ERROR, code: 'INTEGRATION_RESPONSE_INVALID' };
  const status = adapter.mapStatus(bruto);
  if (status === null || status === undefined) return { outcome: ERROR, code: 'INTEGRATION_STATUS_UNMAPPED' };
  return {
    outcome: FOUND, status: String(status).toUpperCase(),
    externalResourceId: answer.externalResourceId ? String(answer.externalResourceId).slice(0, 160) : null,
    externalRequestId: answer.externalRequestId ? String(answer.externalRequestId).slice(0, 160) : null,
  };
}

/** Consulta por método do adapter que devolve o recurso ou "não existe" (null, { found:false } ou HTTP 404). */
async function callLookup(adapter, method, request, meta) {
  try {
    const answer = await adapter[method](adapter.ctx, request, meta);
    if (answer === null || answer === undefined || answer.found === false) return { outcome: NOT_FOUND };
    return toFound(adapter, answer);
  } catch (error) {
    return isNotFound(error) ? { outcome: NOT_FOUND } : { outcome: ERROR, code: codeOf(error) };
  }
}

/** Consulta de status do próprio port, com o id externo (e o que mais o pedido da operação exige, como o slug do site). */
async function callStatus(adapter, statusOp, def, args) {
  const { dispatch, transaction, ctx } = args;
  const base = { externalResourceId: dispatch.externalResourceId, externalRequestId: dispatch.externalRequestId, ...(dispatch.payloadSnapshot || {}) };
  const pedido = {};
  const faltando = (def.inputSchema.required || []).some((campo) => {
    if (base[campo] === undefined || base[campo] === null || base[campo] === '') return true;
    pedido[campo] = base[campo];
    return false;
  });
  if (faltando || !dispatch.externalResourceId) return { outcome: 'SKIPPED' };
  try {
    return toFound(adapter, await invoke(adapter, statusOp, pedido, { tenant: ctx, transaction, meta: { dispatchId: dispatch.id, reconcile: true } }));
  } catch (error) {
    return { outcome: ERROR, code: codeOf(error) };
  }
}

/**
 * runStrategies — as consultas da operação, na ordem do livro (M9-D215 3.2): (1) pela chave de idempotência, (2) pelo status do id externo,
 * (3) pela referência de negócio. A primeira que acha o recurso decide. Sem achar: se TODAS as consultas feitas afirmaram "não existe",
 * o veredito é NOT_FOUND; qualquer consulta que falhou, ou nenhuma consulta possível, deixa INCONCLUSIVE. Devolve { verdict, found, trail }.
 */
async function runStrategies({ ctx, dispatch, adapter, port, statusDef, transaction }) {
  const strategy = port.reconcileStrategy;
  const trail = [];
  const meta = { dispatchId: dispatch.id, reconcile: true };
  const extra = await enrichFor(port.domain, { ctx, dispatch, transaction });
  const plano = [
    ['IDEMPOTENCY_KEY', strategy.key, () => callLookup(adapter, strategy.key, { idempotencyKey: dispatch.idempotencyKey, operation: dispatch.operation, ...extra }, meta)],
    ['STATUS', strategy.status, () => callStatus(adapter, strategy.status, statusDef, { ctx, dispatch, transaction })],
    ['REFERENCE', strategy.reference, () => (dispatch.aggregateId
      ? callLookup(adapter, strategy.reference, {
        aggregateType: dispatch.aggregateType, aggregateId: dispatch.aggregateId, operation: dispatch.operation, payloadHash: dispatch.payloadHash, ...extra,
      }, meta)
      : { outcome: 'SKIPPED' })],
  ];
  let falhou = false;
  let consultou = 0;
  for (const [nome, metodo, rodar] of plano) {
    if (!metodo || (nome !== 'STATUS' && typeof adapter[metodo] !== 'function') || (nome === 'STATUS' && (!statusDef || typeof adapter[metodo] !== 'function'))) {
      trail.push({ strategy: nome, outcome: 'UNSUPPORTED' });
      continue;
    }
    const r = await rodar();
    trail.push({ strategy: nome, method: metodo, outcome: r.outcome, ...(r.code ? { code: r.code } : {}), ...(r.status ? { status: r.status } : {}) });
    if (r.outcome === FOUND) return { verdict: FOUND, found: r, trail };
    if (r.outcome === ERROR) falhou = true;
    if (r.outcome === NOT_FOUND || r.outcome === ERROR) consultou += 1;
  }
  if (falhou || consultou === 0) return { verdict: 'INCONCLUSIVE', found: null, trail };
  return { verdict: NOT_FOUND, found: null, trail };
}

module.exports = { runStrategies, FOUND, NOT_FOUND };
