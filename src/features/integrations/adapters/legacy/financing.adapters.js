'use strict';

const { FinancingProviderAdapter } = require('../../providers/financing/financing.port');
const { SandboxFinancingProviderAdapter, ManualWorkflowFinancingProviderAdapter } = require('../../../correspondent/adapters/FinancingProviderAdapter');
const { wrapLegacy, mapFrom, COMPLETED, verifyOp } = require('../legacyWrap');

const sandboxLegacy = new SandboxFinancingProviderAdapter();
const statusFinanceiro = (s) => (['COMPLETED', 'VALID', 'INVALID'].includes(s) ? s : sandboxLegacy.normalizeProviderStatus(s));

/** financing-sandbox: o sandbox determinístico de financiamento (HMAC real no webhook). */
const FinancingSandboxContractAdapter = wrapLegacy({
  Port: FinancingProviderAdapter,
  className: 'FinancingSandboxContractAdapter',
  code: 'financing-sandbox',
  capabilities: ['simulate', 'submitCase', 'getCaseStatus', 'uploadDocument', 'requestAppraisal', 'verifyWebhook'],
  makeLegacy: () => new SandboxFinancingProviderAdapter(),
  mapper: statusFinanceiro,
  ops: {
    simulate: async (l, req) => { const r = await l.simulate(req); return { externalResourceId: r.externalId ?? null, status: COMPLETED, raw: r }; },
    submitCase: async (l, req, self) => { const r = await l.submitCase(req); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    getCaseStatus: async (l, req, self) => { const r = await l.getCaseStatus(req.externalResourceId); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.rawProviderStatus || r.status), raw: r.raw }; },
    uploadDocument: async (l, req) => { const r = await l.uploadDocument(req); return { externalResourceId: r.externalDocumentId ?? null, status: COMPLETED, raw: r.raw }; },
    requestAppraisal: async (l, req) => { const r = await l.requestAppraisal(req); return { externalResourceId: r.externalId ?? null, status: COMPLETED, raw: r }; },
    verifyWebhook: verifyOp((l, req) => l.verifyWebhook(req.rawBody, req.headers, req.secret)),
  },
});

/** financing-manual: workflow manual assistido (nunca chama a rede; o status só avança por ação humana). */
const FinancingManualContractAdapter = wrapLegacy({
  Port: FinancingProviderAdapter,
  className: 'FinancingManualContractAdapter',
  code: 'financing-manual',
  capabilities: ['submitCase', 'getCaseStatus'],
  makeLegacy: () => new ManualWorkflowFinancingProviderAdapter(),
  mapper: mapFrom({ PENDING_MANUAL_ACTION: 'PENDING_MANUAL_ACTION', COMPLETED: 'COMPLETED' }),
  health: async () => ({ ok: true, latencyMs: 0, detail: 'Fluxo manual: não há fornecedor a consultar.' }),
  ops: {
    submitCase: async (l, req, self) => { const r = await l.submitCase(req); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    getCaseStatus: async (l, req, self) => { const r = await l.getCaseStatus(req.externalResourceId); return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw }; },
  },
});

module.exports = { FinancingSandboxContractAdapter, FinancingManualContractAdapter };
