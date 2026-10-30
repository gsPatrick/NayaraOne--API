'use strict';

const { InsuranceAdapter } = require('../../providers/insurance/insurance.port');
const { ManualInsuranceWorkflow, refOf, ID_PREFIX } = require('../../../procurement/insurance/insurance.workflow');
const { wrapLegacy } = require('../legacyWrap');
const { STATUS, CAPABILITIES } = require('./insurance.ops');

const sandboxMeta = (meta) => {
  if (!meta || !meta.transaction || !meta.tenant) throw Object.assign(new Error('O fluxo manual precisa da empresa e da transação do envio.'), { code: 'INTEGRATION_MANUAL_CONTEXT_MISSING', status: 400 });
  return meta;
};

/** Operações do fluxo manual: quote e propose abrem a tarefa e respondem PENDING; getPolicy e getStatus leem o estado da tarefa; submitClaim registra a submissão. Nenhuma chama rede. */
const OPS = Object.freeze({
  quote: async (l, req, self, meta) => {
    const task = await l.openTask(sandboxMeta(meta), { kind: 'QUOTE_DOCUMENT', purpose: req.purposeKind === 'RENEWAL' ? 'RENEWAL' : 'NEW', policyId: req.policyRef, request: { insuredAmount: req.insuredAmount ?? null, propertyType: req.propertyType ?? null } });
    return { externalResourceId: refOf(task), status: self.normalizeStatus('PENDING'), task: { id: task.id, kind: task.kind }, raw: null };
  },
  propose: async (l, req, self, meta) => {
    const task = await l.openTask(sandboxMeta(meta), { kind: 'PROPOSAL_NUMBER', policyId: req.policyRef, request: { premiumAmount: req.premiumAmount ?? null, effectiveDate: req.effectiveDate ?? null, expiryDate: req.expiryDate ?? null, installmentsCount: req.installmentsCount ?? null } });
    return { externalResourceId: refOf(task), status: self.normalizeStatus('PENDING'), task: { id: task.id, kind: task.kind }, raw: null };
  },
  getPolicy: async (l, req, self, meta) => ({ externalResourceId: req.externalResourceId, status: self.normalizeStatus((await l.statusOf(sandboxMeta(meta), req.externalResourceId)) || 'PENDING'), raw: null }),
  getStatus: async (l, req, self, meta) => ({ externalResourceId: req.externalResourceId, status: self.normalizeStatus((await l.statusOf(sandboxMeta(meta), req.externalResourceId)) || 'PENDING'), raw: null }),
  // Sinistro no fluxo manual: a pessoa avisa a seguradora fora do sistema; o pedido só registra a submissão interna (a indenização é confirmada pela rotina de sempre).
  submitClaim: async (l, req, self) => ({ externalResourceId: `${ID_PREFIX}claim:${req.claimRef}`, status: self.normalizeStatus('UNDER_REVIEW'), raw: null }),
});

/** insurance-manual: a seguradora sem API cumpre o MESMO port InsuranceAdapter por tarefas a uma pessoa; sem rede, sem segredo. */
const InsuranceManualContractAdapter = wrapLegacy({
  Port: InsuranceAdapter, className: 'InsuranceManualContractAdapter', code: 'insurance-manual', capabilities: CAPABILITIES.filter((c) => c !== 'verifyWebhook'), mapper: STATUS, ops: OPS, idempotentOps: ['quote', 'propose', 'submitClaim'], // o sinistro manual tem o identificador derivado de `claimRef`: repetir devolve o mesmo registro
  makeLegacy: () => new ManualInsuranceWorkflow(),
});

module.exports = { InsuranceManualContractAdapter };
