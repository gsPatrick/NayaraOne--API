'use strict';

const { defineMapper } = require('../defineMapper');

/**
 * NFS-e (M9-D241, sobre a M9-D219): a emissão leva o RPS (a chave natural da idempotência), o tomador (PERSONAL), o serviço, o valor como texto decimal e os impostos que o módulo
 * Fiscal já calculou (a integração só transporta valores; o cálculo é do Marco 8). A consulta e o cancelamento levam o identificador da nota no emissor, o RPS e, no cancelamento,
 * o motivo. Nada além disso sai.
 */
const rps = { name: 'rps', classification: 'INTERNAL', shape: [{ name: 'series', classification: 'INTERNAL' }, { name: 'number', classification: 'INTERNAL' }] };

module.exports = {
  issueNfse: defineMapper({
    purpose: 'FISCAL_ISSUANCE',
    fields: [
      { ...rps, required: true },
      { name: 'taker', classification: 'PERSONAL', shape: [{ name: 'name', classification: 'PERSONAL' }, { name: 'document', classification: 'PERSONAL' }] },
      { name: 'service', classification: 'INTERNAL', shape: [{ name: 'code', classification: 'INTERNAL' }, { name: 'description', classification: 'INTERNAL', freeText: true }] },
      { name: 'amount', classification: 'INTERNAL', required: true },
      { name: 'taxes', classification: 'INTERNAL', shape: [{ name: 'issRatePct', classification: 'INTERNAL' }] },
      { name: 'invoiceRef', classification: 'INTERNAL' },
    ],
  }),
  getNfseStatus: defineMapper({
    purpose: 'FISCAL_ISSUANCE',
    fields: [
      { name: 'externalResourceId', classification: 'INTERNAL', required: true },
      { ...rps },
      { name: 'amount', classification: 'INTERNAL' },
      { name: 'serviceDescription', classification: 'INTERNAL', freeText: true },
    ],
  }),
  cancelNfse: defineMapper({
    purpose: 'FISCAL_CANCELLATION',
    fields: [
      { name: 'externalResourceId', classification: 'INTERNAL', required: true },
      { ...rps },
      { name: 'reason', classification: 'INTERNAL', freeText: true, required: true },
    ],
  }),
};
