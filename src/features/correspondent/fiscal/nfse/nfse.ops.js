'use strict';

const crypto = require('node:crypto');
const { IntegrationConnection } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const adapterRegistry = require('../../../integrations/registry/adapterRegistry');
const { transitionDispatch } = require('../../../integrations/dispatch/dispatch.transition');
const { confirmDispatch } = require('../../../integrations/dispatch/worker/worker.confirm');
const { reconcileDispatch } = require('../../../integrations/dispatch/reconcile');
const { callNfse, issuerQueryFailed, findDispatch } = require('./nfse.call');
const { ensureFiscalConnection } = require('./nfse.connection');
const { rpsOf } = require('./nfse.rps');
const { statusDomainObject, cancelDomainObject, invoiceStatusOf } = require('./nfse.domain');

/** A connection da nota: a do envio da emissão (a nota fica ligada ao emissor que a recebeu) ou, para nota anterior ao registro, a atual da empresa. */
async function connectionOf(ctx, invoice, transaction) {
  const envio = invoice.dispatchId ? await findDispatch(ctx, invoice.dispatchId, transaction) : null;
  const conexao = envio ? await IntegrationConnection.findOne({ where: { id: envio.connectionId, companyId: ctx.companyId }, transaction }) : null;
  return conexao || ensureFiscalConnection(ctx, transaction);
}

/** Consulta de status da nota pelo Dispatch Service (SAFE): o mesmo formato que o módulo Fiscal já aplicava (status, número oficial, arquivos, motivo da recusa). */
async function queryInvoiceStatus(ctx, invoice, { transaction, timeoutMs, withTimeout }) {
  const connection = await connectionOf(ctx, invoice, transaction);
  const out = await callNfse({
    ctx, connection, operation: 'getNfseStatus', aggregateId: invoice.id, payload: statusDomainObject({ invoice, rps: rpsOf(invoice) }), idempotencyKey: `nfse-status:${invoice.id}:${crypto.randomUUID()}`, transaction, useOwn: false, timeoutMs, withTimeout,
  });
  if (out.state !== 'OK' || !out.response) throw issuerQueryFailed();
  const r = out.response;
  return { status: invoiceStatusOf(r.status), rawProviderStatus: r.rawProviderStatus || r.status, officialNumber: r.officialNumber || null, documents: r.documents || null, rejectionReason: r.rejectionReason || null };
}

/** A chave que identifica a emissão no emissor: a derivada do RPS; nota anterior ao registro usa a chave que o Fiscal sempre usou. */
const issuanceKeyOf = (invoice) => invoice.issuerKey || `nfse:${invoice.companyId}:${invoice.sourceType}:${invoice.sourceId}:n${invoice.attemptNumber}`;

/**
 * Consulta READ-ONLY ao emissor pelo RPS e pela chave (M9-D241 3.2 item 1, "UNKNOWN: consulta por RPS/protocolo antes de reemitir"): o pedido incerto existe lá? Devolve
 * { found, externalId }. Emissor que não responde: 422 NFSE_ISSUER_QUERY_FAILED (nunca presume que não existe).
 */
async function lookupIssuance(ctx, invoice, { transaction, timeoutMs, withTimeout }) {
  try {
    const connection = await connectionOf(ctx, invoice, transaction);
    const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
    const pedido = { idempotencyKey: issuanceKeyOf(invoice), operation: 'issueNfse', rps: rpsOf(invoice) || undefined };
    const consultas = [typeof adapter.findByIdempotencyKey === 'function' ? () => adapter.findByIdempotencyKey(adapter.ctx, pedido) : null, typeof adapter.findByReference === 'function' && pedido.rps ? () => adapter.findByReference(adapter.ctx, pedido) : null].filter(Boolean);
    if (consultas.length === 0) throw issuerQueryFailed();
    for (const consulta of consultas) {
      const r = await withTimeout(consulta(), timeoutMs);  
      if (r && r.found !== false && r.externalResourceId) return { found: true, externalId: String(r.externalResourceId) };
    }
    return { found: false, externalId: null };
  } catch (err) {
    if (err && err.code === 'NFSE_ISSUER_QUERY_FAILED') throw err;
    throw AppError.unprocessable('Não foi possível consultar o emissor agora. Tente de novo em instantes.', 'NFSE_ISSUER_QUERY_FAILED');
  }
}

/**
 * Fecha o envio da emissão depois da consulta: achada, a reconciliação do framework (D215) leva o envio ao estado do emissor sem reenviar; não achada e a emissão encerrada, a
 * reconciliação conclui "sem registro" e o envio é CANCELADO, para o worker nunca emitir a nota depois de a empresa ter liberado uma nova. Nunca derruba a consulta.
 */
async function settleIssuanceDispatch(ctx, invoice, { found }, transaction) {
  if (!invoice.dispatchId) return;
  try {
    const envio = await findDispatch(ctx, invoice.dispatchId, transaction);
    if (!envio) return;
    if (envio.status === 'UNKNOWN') await reconcileDispatch(ctx, envio.id, { transaction });
    if (found) return;
    const atual = await findDispatch(ctx, envio.id, transaction);
    if (['RETRY_WAIT', 'PENDING'].includes(atual.status)) await transitionDispatch(ctx, atual.id, 'CANCELLED', {}, { motivo: 'O emissor confirmou que não recebeu a nota: a emissão foi encerrada e uma nova está liberada.' }, transaction);
  } catch { /* o envio fica para a rodada de reconciliação do framework */ }
}

/**
 * O status final da nota no emissor fecha o envio da emissão (M9-D241 3.2): AUTHORIZED confirma (evidência: consulta de status), REJECTED encerra com falha. PROCESSING e CANCELED não
 * mexem. Nunca derruba a consulta.
 */
async function finishIssuanceDispatch(ctx, invoice, result, transaction) {
  if (!invoice.dispatchId || !['AUTHORIZED', 'REJECTED'].includes(result.status)) return;
  try {
    const envio = await findDispatch(ctx, invoice.dispatchId, transaction);
    if (!envio || !['SUBMITTED', 'UNKNOWN'].includes(envio.status)) return;
    if (result.status === 'AUTHORIZED') await confirmDispatch(ctx, envio.id, { source: 'STATUS_QUERY', status: 'AUTHORIZED', externalResourceId: invoice.externalId }, transaction);
    else await transitionDispatch(ctx, envio.id, 'FAILED', { lastErrorClass: 'VALIDATION', lastErrorCode: 'EXTERNAL_REJECTED' }, { motivo: 'A prefeitura recusou a nota.' }, transaction);
  } catch { /* o envio fica para a rodada de reconciliação do framework */ }
}

/**
 * Cancelamento da nota (M9-D241 3.2 item 3): DANGEROUS, com motivo obrigatório (422 INTEGRATION_FISCAL_CANCEL_REASON_REQUIRED) e confirmado SÓ pelo status CANCELED do emissor
 * (consulta de status depois do pedido). Chave `nfse-cancel:{RPS}`: repetir devolve o mesmo envio. Devolve { canceled, status }; emissor sem resposta: 422 NFSE_ISSUER_QUERY_FAILED.
 */
async function cancelAtIssuer(ctx, invoice, reason, { transaction, timeoutMs, withTimeout }) {
  const motivo = String(reason === undefined || reason === null ? '' : reason).trim();
  if (!motivo) throw AppError.unprocessable('Informe o motivo do cancelamento da nota.', 'INTEGRATION_FISCAL_CANCEL_REASON_REQUIRED');
  const connection = await connectionOf(ctx, invoice, transaction);
  const out = await callNfse({
    ctx, connection, operation: 'cancelNfse', aggregateId: invoice.id, payload: cancelDomainObject({ invoice, rps: rpsOf(invoice), reason: motivo }),
    idempotencyKey: invoice.rpsNumber !== null && invoice.rpsNumber !== undefined ? `nfse-cancel:${invoice.rpsSeries}-${invoice.rpsNumber}` : `nfse-cancel:${invoice.id}`, transaction, useOwn: false, timeoutMs, withTimeout,
  });
  if (out.state !== 'OK') throw issuerQueryFailed();
  const consulta = await queryInvoiceStatus(ctx, invoice, { transaction, timeoutMs, withTimeout });
  if (consulta.status === 'CANCELED') {
    await confirmDispatch(ctx, out.dispatch.id, { source: 'STATUS_QUERY', status: 'CANCELED', externalResourceId: invoice.externalId }, transaction);
    return { canceled: true, status: 'CANCELED' };
  }
  return { canceled: false, status: consulta.status };
}

module.exports = { queryInvoiceStatus, lookupIssuance, settleIssuanceDispatch, finishIssuanceDispatch, cancelAtIssuer, connectionOf, issuanceKeyOf };
