'use strict';

const { InvoiceRequest } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { transitionDispatch } = require('../../../integrations/dispatch/dispatch.transition');
const { sanitizeProviderMessage } = require('../../sanitizeProviderMessage');
const { callNfse, enqueueNfse, findDispatch } = require('./nfse.call');
const { issueDomainObject } = require('./nfse.domain');
const { installNfseReactions } = require('./nfse.react');

installNfseReactions(); // M9-D220: o estado da nota muda por evento interno do envio, e a emissão tardia vira cancelamento compensatório

/** Pedido de emissão ao Dispatch Service: conteúdo do domínio e chave de idempotência (= o RPS). */
const issueEnqueueArgs = (a, invoice) => ({
  ctx: a.ctx, connection: a.connection, operation: 'issueNfse', aggregateId: invoice.id,
  payload: issueDomainObject({ invoice, rps: a.rps, amount: a.amount, description: a.description, fiscal: a.fiscal, takerTaxId: a.takerTaxId, takerName: a.takerName }), idempotencyKey: a.rps.key,
});

/** Cria o envio da emissão na transação em que a nota nasce (M9-D220: o pedido ao emissor e o dado do domínio são confirmados ou desfeitos juntos). `a`: ctx, connection, rps, amount, description, fiscal, takerTaxId, takerName. */
const enqueueIssue = (a, invoice, transaction) => enqueueNfse({ ...issueEnqueueArgs(a, invoice), transaction });

/**
 * Emissão da nota pelo Dispatch Service (M9-D241 3.2): conteúdo minimizado, chave = RPS, chamada feita pelo worker de envios (circuito, cota e nova tentativa do framework) e o
 * resultado gravado na nota. Só esta chamada é ambígua: timeout, erro ou resposta incerta deixam a nota UNKNOWN (nunca reenvio cego; a consulta por RPS resolve). Recusa síncrona da
 * prefeitura deixa a nota REJECTED com o motivo e o envio FAILED. Circuito aberto, cota ou conexão parada deixam o pedido na fila (a nota fica REQUESTED e o worker envia depois).
 * Falha de banco depois da chamada sobe como erro. `a`: ctx, connection, invoiceRequest, rps, amount, description, fiscal, takerTaxId, takerName, actorUserId, transaction, useOwn,
 * timeoutMs, withTimeout, NfseTimeoutError, runOwn(fn) e appendEvent(row, rawStatus, normalizedStatus, tx, note) do serviço do Fiscal.
 */
async function issueViaDispatch(a) {
  const { ctx, invoiceRequest, transaction } = a;
  let saida;
  try {
    saida = await callNfse({
      ...issueEnqueueArgs(a, invoiceRequest), dispatch: a.dispatchId ? await findDispatch(ctx, a.dispatchId, transaction) : undefined,
      transaction, useOwn: a.useOwn, timeoutMs: a.timeoutMs, withTimeout: a.withTimeout,
    });
  } catch (err) {
    saida = { state: 'UNCERTAIN', dispatch: null, response: null, error: err };
  }
  const incerto = saida.state === 'UNCERTAIN' || saida.state === 'FAILED';
  const motivo = saida.error instanceof a.NfseTimeoutError ? 'tempo esgotado' : 'erro';
  const persist = async (tx) => {
    const row = await InvoiceRequest.findByPk(invoiceRequest.id, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (saida.dispatch && !row.dispatchId) row.dispatchId = saida.dispatch.id;
    // O observador do worker já ligou a resposta à nota; se não ligou, o identificador do envio basta.
    if (saida.state === 'OK' && !row.externalId && saida.dispatch && saida.dispatch.externalResourceId && row.status === 'REQUESTED') {
      row.externalId = String(saida.dispatch.externalResourceId).slice(0, 128);
      row.status = 'SUBMITTED';
      await a.appendEvent(row, 'SUBMITTED', 'SUBMITTED', tx);
    }
    if (incerto && row.status === 'REQUESTED') {
      row.status = 'UNKNOWN';
      await a.appendEvent(row, 'UNKNOWN', null, tx, `Resposta incerta do emissor (${motivo}).`);
    }
    if (saida.state === 'DEFERRED') await a.appendEvent(row, 'QUEUED', row.status, tx, 'O emissor não pôde receber agora: o pedido fica na fila e sai quando a integração voltar.');
    row.updatedBy = a.actorUserId || null;
    await row.save({ transaction: tx });
    // Recusa síncrona: o envio termina em FAILED; a correção é outra nota, com outro RPS.
    if (row.status === 'REJECTED' && saida.dispatch) {
      const envio = await findDispatch(ctx, saida.dispatch.id, tx);
      if (envio && envio.status === 'SUBMITTED') await transitionDispatch(ctx, envio.id, 'FAILED', { lastErrorClass: 'VALIDATION', lastErrorCode: 'EXTERNAL_REJECTED' }, { motivo: 'A prefeitura recusou a nota.' }, tx);
    }
  };
  // O envio e o identificador do emissor são gravados e confirmados na hora (transação própria): se a requisição voltar depois, a nota continua ligada ao pedido do emissor.
  if (a.useOwn) await a.runOwn(persist); else await persist(transaction);
  await invoiceRequest.reload({ transaction });
  if (incerto) {
    await registrarAuditoria({
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: a.actorUserId, action: 'correspondent.nfse.unknown', entityType: 'InvoiceRequest', entityId: invoiceRequest.id,
      reason: `Emissão de NFS-e ficou incerta (${motivo}): ${sanitizeProviderMessage(saida.error && saida.error.message)}`,
    }, transaction);
  }
  return saida;
}

module.exports = { issueViaDispatch, enqueueIssue };
