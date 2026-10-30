'use strict';

const { FinancingProviderAdapter } = require('../../providers/financing/financing.port');
const { SandboxFinancingProviderAdapter, ManualWorkflowFinancingProviderAdapter } = require('../../../correspondent/adapters/FinancingProviderAdapter');
const { wrapLegacy, mapFrom, COMPLETED, verifyOp } = require('../legacyWrap');

const sandboxLegacy = new SandboxFinancingProviderAdapter();
/**
 * Pedido do contrato (dado minimizado: caseRef, amount, proponente) -> pedido da interface original do Correspondente ({ financingCaseId, amount, idempotencyKey, consent }).
 * O consentimento já foi exigido antes de o envio nascer; a chave de idempotência chega em `meta` (a mesma da submissão, M9-D240).
 */
const pedidoAntigo = (req, meta) => ({
  financingCaseId: req.caseRef !== undefined ? req.caseRef : req.financingCaseId,
  amount: req.amount !== undefined ? req.amount : req.propertyValue,
  idempotencyKey: meta && meta.idempotencyKey !== undefined ? meta.idempotencyKey : req.idempotencyKey,
  consent: true,
});

const statusFinanceiro = (s) => (['COMPLETED', 'VALID', 'INVALID'].includes(s) ? s : sandboxLegacy.normalizeProviderStatus(s));

/** financing-sandbox: o sandbox determinístico de financiamento (HMAC real no webhook). */
const FinancingSandboxContractAdapter = wrapLegacy({
  Port: FinancingProviderAdapter,
  className: 'FinancingSandboxContractAdapter',
  code: 'financing-sandbox',
  capabilities: ['simulate', 'submitCase', 'getCaseStatus', 'uploadDocument', 'requestAppraisal', 'verifyWebhook', 'cancelCase'],
  makeLegacy: () => new SandboxFinancingProviderAdapter(),
  mapper: statusFinanceiro,
  idempotentOps: ['submitCase', 'uploadDocument', 'requestAppraisal'],
  lookups: {
    // Reconciliação (M9-D215): o sandbox guarda o que aceitou pela chave; "não achei" é afirmação do próprio fornecedor.
    findByIdempotencyKey: async (l, req) => {
      const r = await l.findSubmissionByKey(req.idempotencyKey);
      return r.found ? { found: true, status: r.status || 'SUBMITTED', externalResourceId: r.externalId } : { found: false };
    },
  },
  ops: {
    simulate: async (l, req) => { const r = await l.simulate(req); return { externalResourceId: r.externalId ?? null, status: COMPLETED, raw: r }; },
    submitCase: async (l, req, self, meta) => { const r = await l.submitCase(pedidoAntigo(req, meta)); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    getCaseStatus: async (l, req, self) => { const r = await l.getCaseStatus(req.externalResourceId); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.rawProviderStatus || r.status), raw: r.raw }; },
    uploadDocument: async (l, req, _self, meta) => { const r = await l.uploadDocument({ ...req, idempotencyKey: meta && meta.idempotencyKey }); return { externalResourceId: r.externalDocumentId ?? null, status: COMPLETED, raw: r.raw }; },
    requestAppraisal: async (l, req, _self, meta) => { const r = await l.requestAppraisal({ ...req, idempotencyKey: meta && meta.idempotencyKey }); return { externalResourceId: r.externalId ?? null, status: COMPLETED, raw: r }; },
    verifyWebhook: verifyOp((l, req) => l.verifyWebhook(req.rawBody, req.headers, req.secret)),
    // Compensação do caso aceito (M9-D220): o provider cancela o caso pelo id externo.
    cancelCase: async (l, req, self) => { const r = await l.cancelCase(req.externalResourceId); return { externalResourceId: r.externalId, status: self.normalizeStatus('CANCELED'), raw: r }; },
  },
});

/** financing-manual: workflow manual assistido (nunca chama a rede; o status só avança por ação humana). */
const FinancingManualContractAdapter = wrapLegacy({
  Port: FinancingProviderAdapter,
  className: 'FinancingManualContractAdapter',
  code: 'financing-manual',
  capabilities: ['submitCase', 'getCaseStatus', 'cancelCase'],
  makeLegacy: () => new ManualWorkflowFinancingProviderAdapter(),
  mapper: mapFrom({ PENDING_MANUAL_ACTION: 'PENDING_MANUAL_ACTION', COMPLETED: 'COMPLETED', CANCELED: 'CANCELED' }),
  health: async () => ({ ok: true, latencyMs: 0, detail: 'Fluxo manual: não há fornecedor a consultar.' }),
  idempotentOps: ['submitCase'],
  ops: {
    submitCase: async (l, req, self, meta) => { const r = await l.submitCase(pedidoAntigo(req, meta)); return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    getCaseStatus: async (l, req, self) => { const r = await l.getCaseStatus(req.externalResourceId); return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw }; },
    cancelCase: async (l, req, self) => { const r = await l.cancelCase(req.externalResourceId); return { externalResourceId: r.externalId, status: self.normalizeStatus('CANCELED'), raw: r.raw }; },
  },
});

module.exports = { FinancingSandboxContractAdapter, FinancingManualContractAdapter };
