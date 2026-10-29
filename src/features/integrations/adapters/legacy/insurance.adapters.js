'use strict';

const { InsuranceAdapter } = require('../../providers/insurance/insurance.port');
const { SandboxInsuranceAdapter } = require('../../../procurement/adapters/InsuranceAdapter');
const { wrapLegacy, mapFrom, COMPLETED } = require('../legacyWrap');

/** insurance-sandbox: cotação, apólice e sinistro simulados (sem rede). */
const InsuranceSandboxContractAdapter = wrapLegacy({
  Port: InsuranceAdapter,
  className: 'InsuranceSandboxContractAdapter',
  code: 'insurance-sandbox',
  capabilities: ['quote', 'propose', 'getPolicy', 'getStatus'],
  makeLegacy: () => new SandboxInsuranceAdapter(),
  mapper: mapFrom({ ACTIVE: 'ACTIVE', UNDER_REVIEW: 'UNDER_REVIEW', APPROVED: 'APPROVED', DENIED: 'DENIED', SETTLED: 'SETTLED', CANCELED: 'CANCELED', COMPLETED }),
  ops: {
    quote: async (l, req) => { const r = await l.quote(req); return { externalResourceId: r.externalId, status: COMPLETED, raw: r }; },
    propose: async (l, req, self) => { const r = await l.issuePolicy(req); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r }; },
    getPolicy: async (l, req, self) => { const r = await l.getPolicyStatus(req.externalResourceId); return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    getStatus: async (l, req, self) => { const r = await l.getClaimStatus(req.externalResourceId); return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw }; },
  },
});

module.exports = { InsuranceSandboxContractAdapter };
