'use strict';

const { sequelize, InvoiceRequest, InvoiceEvent } = require('../../../../models');
const { registerCallObserver } = require('../../../integrations/dispatch/worker/worker.hooks');
const { registerReconcileEnricher } = require('../../../integrations/dispatch/reconcile/reconcile.enrichers');
const { invoiceStatusOf } = require('./nfse.domain');

/**
 * Liga a resposta do emissor à nota (M9-D241): quando `issueNfse` é aceito, o worker de envios entrega a resposta e este observador grava o identificador da nota no emissor (o
 * protocolo) e leva o pedido de REQUESTED/UNKNOWN a SUBMITTED, ou a REJECTED com o motivo da prefeitura quando a recusa é síncrona. Vale para o envio feito na hora e para o que o
 * worker manda depois (circuito, cota ou conexão parada). Roda num SAVEPOINT: falhar aqui nunca derruba o envio. Idempotente: só toca nota ainda sem identificador.
 */
async function bindIssueResult({ dispatch, response, transaction }) {
  const invoice = await InvoiceRequest.findOne({ where: { id: dispatch.aggregateId, companyId: dispatch.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!invoice || invoice.externalId || !['REQUESTED', 'UNKNOWN'].includes(invoice.status)) return;
  const providerStatus = String(response.status || '').toUpperCase();
  if (providerStatus === 'REJECTED') {
    const motivo = String(response.rejectionReason || 'O emissor não informou o motivo da recusa.').slice(0, 2000);
    await invoice.update({ status: 'REJECTED', rejectionReason: motivo, dispatchId: dispatch.id }, { transaction });
    await InvoiceEvent.create({ groupId: invoice.groupId, companyId: invoice.companyId, invoiceRequestId: invoice.id, rawStatus: 'REJECTED', normalizedStatus: 'REJECTED', note: motivo.slice(0, 1000), occurredAt: new Date() }, { transaction });
    return;
  }
  if (!response.externalResourceId) return;
  await invoice.update({ externalId: String(response.externalResourceId).slice(0, 128), status: invoiceStatusOf(providerStatus === 'AUTHORIZED' ? 'PROCESSING' : providerStatus) || 'SUBMITTED', dispatchId: dispatch.id }, { transaction });
  await InvoiceEvent.create({ groupId: invoice.groupId, companyId: invoice.companyId, invoiceRequestId: invoice.id, rawStatus: 'SUBMITTED', normalizedStatus: invoice.status, note: null, occurredAt: new Date() }, { transaction });
}

let installed = false;
/** Registra o observador do envio e os dados que a reconciliação entrega ao adapter (o RPS da emissão), uma vez por processo. */
function installNfseBinder() {
  if (installed) return;
  installed = true;
  registerCallObserver(async (args) => {
    const { dispatch, response, error } = args;
    if (error || !response || dispatch.operation !== 'issueNfse' || dispatch.aggregateType !== 'InvoiceRequest') return;
    try {
      await sequelize.transaction({ transaction: args.transaction }, (savepoint) => bindIssueResult({ ...args, transaction: savepoint }));
    } catch { /* o savepoint desfez só a ligação; o pedido segue e a consulta de status acha a nota pelo RPS */ }
  });
  registerReconcileEnricher('FISCAL', ({ dispatch }) => ({ rps: dispatch.payloadSnapshot && dispatch.payloadSnapshot.rps ? dispatch.payloadSnapshot.rps : undefined }));
}

module.exports = { installNfseBinder, bindIssueResult };
