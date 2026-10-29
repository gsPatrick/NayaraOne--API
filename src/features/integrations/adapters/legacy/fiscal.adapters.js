'use strict';

const { FiscalAdapter } = require('../../providers/fiscal/fiscal.port');
const { SandboxNfseAdapter } = require('../../../correspondent/adapters/NfseAdapter');
const { wrapLegacy, mapFrom } = require('../legacyWrap');

/** fiscal-sandbox: NFS-e simulada (sem rede), idempotente pela chave do pedido. */
const FiscalSandboxContractAdapter = wrapLegacy({
  Port: FiscalAdapter,
  className: 'FiscalSandboxContractAdapter',
  code: 'fiscal-sandbox',
  capabilities: ['issueNfse', 'getNfseStatus', 'cancelNfse'],
  makeLegacy: () => new SandboxNfseAdapter(),
  mapper: mapFrom({ SUBMITTED: 'PENDING', AUTHORIZED: 'ISSUED', ISSUED: 'ISSUED', REJECTED: 'REJECTED', CANCELED: 'CANCELED', CANCELLED: 'CANCELED' }),
  ops: {
    issueNfse: async (l, req, self) => { const r = await l.requestInvoice(req); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    getNfseStatus: async (l, req, self) => { const r = await l.getInvoiceStatus(req.externalResourceId, req.context || {}); return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.rawProviderStatus || r.status), raw: r.raw }; },
    cancelNfse: async (l, req, self) => { const r = await l.cancelInvoice(req.externalResourceId); return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw }; },
  },
});

module.exports = { FiscalSandboxContractAdapter };
