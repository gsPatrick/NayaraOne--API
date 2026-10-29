'use strict';

const { IntegrationDispatch } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { applyTransition } = require('../dispatch.transition');
const { publishDispatchEvent, EVENTS } = require('../dispatch.events');
const { portOperation } = require('../enqueue/resolveTarget');

const SOURCES = Object.freeze(['RESPONSE', 'RESPONSE_ID', 'WEBHOOK_SIGNED', 'STATUS_QUERY']);

/**
 * confirmDispatch — leva o envio a CONFIRMED SOMENTE com evidência suficiente (M9-D214 3.3). Operação ON_STATUS (pagamento,
 * assinatura, financiamento, publicação) exige status final por webhook assinado (`WEBHOOK_SIGNED`) ou consulta de status
 * (`STATUS_QUERY`): a resposta de submissão (`RESPONSE`, HTTP 200 ou 202) nunca confirma. `RESPONSE_ID` (M9-D239): a rede que não tem consulta de status
 * (`adapter.confirmsOnResponse`) confirma pela resposta que traz o id do recurso e um status final de sucesso. Ao confirmar grava confirmed_at e publica
 * `integration.dispatch.confirmed` no outbox, na mesma transação e uma única vez. Confirmar de novo não faz nada.
 * `evidence`: { source, status, externalResourceId }.
 */
async function confirmDispatch(ctx, dispatchId, evidence, transaction) {
  const ev = evidence || {};
  if (!SOURCES.includes(ev.source)) throw AppError.unprocessable(`Origem da evidência inválida. Use: ${SOURCES.join(', ')}.`, 'INTEGRATION_CONFIRMATION_EVIDENCE_INVALID');
  const row = await IntegrationDispatch.findOne({ where: { id: dispatchId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw AppError.notFound('Envio não encontrado.', 'INTEGRATION_DISPATCH_NOT_FOUND');
  if (row.status === 'CONFIRMED') return { dispatch: row, confirmed: false };
  const modo = row.confirmationMode || (await portOperation(row.providerCode, row.operation, transaction)).def?.confirmation || 'ON_STATUS';
  if (modo === 'ON_STATUS' && ev.source === 'RESPONSE') {
    throw AppError.conflict('Esta operação só é confirmada pelo status final do fornecedor, não pela resposta de envio.', 'INTEGRATION_CONFIRMATION_EVIDENCE_REQUIRED');
  }
  const patch = { externalStatus: ev.status ? String(ev.status).slice(0, 64) : undefined };
  if (ev.externalResourceId) patch.externalResourceId = String(ev.externalResourceId).slice(0, 160);
  await applyTransition(ctx, row, 'CONFIRMED', patch, { motivo: `Envio confirmado (${ev.source}).` }, transaction);
  await publishDispatchEvent(ctx, row, EVENTS.CONFIRMED, { source: ev.source }, transaction);
  return { dispatch: row, confirmed: true };
}

module.exports = { confirmDispatch, SOURCES };
