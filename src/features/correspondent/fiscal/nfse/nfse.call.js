'use strict';

const { sequelize, IntegrationDispatch } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
require('../../../integrations/dispatch'); // carrega a política de nova tentativa por classe de erro, a cota e a reconciliação (D216, D218 e D215), mesmo fora do servidor
const dispatchService = require('../../../integrations/dispatch/enqueue/dispatch.service');
const { transitionDispatch } = require('../../../integrations/dispatch/dispatch.transition');
const { processClaimed } = require('../../../integrations/dispatch/worker/worker.process');
const { registerCallObserver } = require('../../../integrations/dispatch/worker/worker.hooks');
const { tenantTx } = require('../../../integrations/dispatch/worker/tenantTx');

const OPERATIONS = ['issueNfse', 'getNfseStatus', 'cancelNfse'];
const REMEMBER_MAX = 500;
const RESPONSES = new Map();
const ERRORS = new Map();
const remember = (map, key, value) => { if (map.size >= REMEMBER_MAX) map.delete(map.keys().next().value); map.set(key, value); };

// O worker devolve ao domínio só o resultado normalizado; a consulta de status precisa do número oficial, do código de verificação e dos arquivos (XML e PDF), que vêm na resposta
// da prefeitura, e o erro do emissor ajuda a explicar a falha. O observador do worker os anota por envio, em memória, até quem pediu ler (mesmo desenho do Correspondente, M9-D240).
registerCallObserver(({ dispatch, error, response }) => {
  if (dispatch.aggregateType !== 'InvoiceRequest' || !OPERATIONS.includes(dispatch.operation)) return;
  if (error) remember(ERRORS, dispatch.id, error);
  else if (response) remember(RESPONSES, dispatch.id, response);
});

const runnerOf = (ctx, transaction, useOwn) => (fn) => (useOwn || !transaction ? tenantTx(ctx, fn) : sequelize.transaction({ transaction }, fn));
const findDispatch = (ctx, id, t) => IntegrationDispatch.findOne({ where: { id, companyId: ctx.companyId }, transaction: t });

/**
 * callNfse — o pedido ao emissor pelo Dispatch Service (M9-D241 3.2): `enqueue` com o conteúdo minimizado e a chave informada, e a chamada feita pelo worker de envios (circuito, cota e
 * nova tentativa do framework), esperando no máximo o tempo do Fiscal (`withTimeout`). Devolve { dispatch, response, state }: state OK (o emissor respondeu), UNCERTAIN (tempo esgotado ou
 * resposta incerta: o envio segue UNKNOWN/SENDING para a reconciliação, sem reemitir), DEFERRED (nada saiu: circuito aberto, cota ou conexão parada; o envio fica na fila) ou FAILED (o emissor
 * recusou o pedido). `args`: ctx, connection, operation, aggregateId, payload, idempotencyKey, transaction, useOwn, timeoutMs, withTimeout.
 */
async function callNfse(args) {
  const { ctx, connection, operation, aggregateId, payload, idempotencyKey, transaction, useOwn, timeoutMs, withTimeout } = args;
  const run = runnerOf(ctx, transaction, useOwn);
  const { dispatch: criado } = await run((t) => dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: connection.id, operation, aggregateType: 'InvoiceRequest', aggregateId, payload, idempotencyKey, userId: ctx.userId || null, transaction: t,
  }));
  let dispatch = criado;
  if (['PENDING', 'RETRY_WAIT'].includes(dispatch.status)) {
    await run((t) => transitionDispatch(ctx, dispatch.id, 'SENDING', {}, { motivo: 'Envio pego pelo fluxo de NFS-e do Correspondente.' }, t));
    let r;
    try {
      r = await withTimeout(processClaimed(ctx, dispatch.id, { transaction: useOwn ? null : transaction }), timeoutMs);
    } catch (error) {
      return { dispatch: await run((t) => findDispatch(ctx, dispatch.id, t)), response: null, state: 'UNCERTAIN', error };
    }
    dispatch = await run((t) => findDispatch(ctx, dispatch.id, t));
    const erro = ERRORS.get(dispatch.id) || r.error || null;
    ERRORS.delete(dispatch.id);
    if (!r.ok) {
      if (r.deferred) return { dispatch, response: null, state: 'DEFERRED', error: erro };
      if (['UNKNOWN', 'SENDING'].includes(dispatch.status)) return { dispatch, response: null, state: 'UNCERTAIN', error: erro };
      if (dispatch.status === 'RETRY_WAIT') return { dispatch, response: null, state: 'UNCERTAIN', error: erro }; // a nova tentativa é do worker, com a mesma chave
      return { dispatch, response: null, state: 'FAILED', error: erro };
    }
  } else if (dispatch.status === 'UNKNOWN') {
    return { dispatch, response: null, state: 'UNCERTAIN', error: null };
  }
  const response = RESPONSES.get(dispatch.id) || null;
  RESPONSES.delete(dispatch.id);
  return { dispatch, response, state: 'OK', error: null };
}

/** Falha do emissor como erro de negócio, sem expor o corpo da resposta. */
const issuerQueryFailed = () => AppError.unprocessable('O emissor não respondeu a tempo. A nota continua como está; tente consultar de novo.', 'NFSE_ISSUER_QUERY_FAILED');

module.exports = { callNfse, issuerQueryFailed, findDispatch };
