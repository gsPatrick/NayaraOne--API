'use strict';

const { FiscalAdapter } = require('../../providers/fiscal/fiscal.port');
const { SandboxNfseAdapter } = require('../../../correspondent/adapters/NfseAdapter');
const { wrapLegacy, mapFrom } = require('../legacyWrap');

/** Estados da nota no emissor (M9-D241 3.1): PROCESSING, AUTHORIZED, REJECTED e CANCELED. O sandbox antigo fala SUBMITTED para "em processamento". */
const STATUS = mapFrom({ SUBMITTED: 'PROCESSING', PROCESSING: 'PROCESSING', AUTHORIZED: 'AUTHORIZED', ISSUED: 'AUTHORIZED', REJECTED: 'REJECTED', CANCELED: 'CANCELED', CANCELLED: 'CANCELED' });

/** Falha injetada pela connection (`config.sandbox_fault`): TIMEOUT_AFTER_SEND (o emissor grava o RPS e a resposta se perde, uma vez por chave) e HTTP_503. */
const FAULTS_USED = new Set();
const faultOf = (self) => (self.ctx.connection.config || {}).sandbox_fault;
const erroHttp = (status, message) => Object.assign(new Error(message), { status });

// O sandbox é global ao processo: a chave e o RPS levam o id da connection, para empresas e testes diferentes (cada um com a sua connection) nunca colidirem no mesmo RPS.
const scoped = (self, valor) => (valor ? `${self.ctx.connection.id}|${valor}` : valor);
const rpsText = (rps) => (rps && rps.number !== undefined ? `${rps.series || ''}-${rps.number}` : null);

/** Emissão: o pedido do port vira o pedido do objeto antigo. `externalResourceId` é o protocolo (o id da nota no emissor); a recusa síncrona devolve REJECTED com o motivo. */
async function issueNfse(l, req, self, meta) {
  if (faultOf(self) === 'HTTP_503') throw erroHttp(503, 'Emissor indisponível');
  const chave = (meta && meta.idempotencyKey) || req.idempotencyKey;
  const r = await l.requestInvoice({
    idempotencyKey: scoped(self, chave), rps: scoped(self, rpsText(req.rps)), amount: Number(req.amount), description: req.service && req.service.description, serviceCode: req.service && req.service.code,
    issRatePct: req.taxes && req.taxes.issRatePct, takerTaxId: req.taker && req.taker.document, takerName: req.taker && req.taker.name,
  });
  if (faultOf(self) === 'TIMEOUT_AFTER_SEND' && chave && !FAULTS_USED.has(`${self.ctx.connection.id}|${chave}`)) {
    FAULTS_USED.add(`${self.ctx.connection.id}|${chave}`);
    throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  }
  return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), rejectionReason: r.rejectionReason || null, raw: r.raw };
}

/** Consulta: o status mais o número oficial, o código de verificação e os arquivos (XML e PDF) quando autorizada; a resposta completa só chega ao módulo Fiscal pelo observador do worker. */
async function getNfseStatus(l, req, self) {
  const r = await l.getInvoiceStatus(req.externalResourceId, { amount: req.amount, description: req.serviceDescription });
  return {
    externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.rawProviderStatus || r.status), rawProviderStatus: r.rawProviderStatus || r.status,
    officialNumber: r.officialNumber || null, rejectionReason: r.rejectionReason || null, documents: r.documents || null, raw: r.raw,
  };
}

/** Cancelamento: devolve o status do pedido (o fornecedor confirma CANCELED na consulta). */
async function cancelNfse(l, req, self) {
  const r = await l.cancelInvoice(req.externalResourceId);
  return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw };
}

/** Consultas de reconciliação (M9-D215): pela chave de idempotência e pelo RPS. Sem registro, a emissão pode sair de novo com o MESMO RPS. */
const findByIdempotencyKey = async (l, req, self) => {
  const r = await l.findInvoiceByKey(scoped(self, req.idempotencyKey));
  return r.found ? { found: true, externalResourceId: r.externalId, status: 'SUBMITTED' } : { found: false };
};
const findByReference = async (l, req, self) => {
  if (!req.rps || typeof l.findInvoiceByRps !== 'function') return { found: false };
  const r = await l.findInvoiceByRps(scoped(self, rpsText(req.rps)));
  return r.found ? { found: true, externalResourceId: r.externalId, status: 'SUBMITTED' } : { found: false };
};

/** fiscal-sandbox: NFS-e simulada (sem rede), idempotente pelo RPS da nota. */
const FiscalSandboxContractAdapter = wrapLegacy({
  Port: FiscalAdapter,
  className: 'FiscalSandboxContractAdapter',
  code: 'fiscal-sandbox',
  capabilities: ['issueNfse', 'getNfseStatus', 'cancelNfse'],
  makeLegacy: () => new SandboxNfseAdapter(),
  mapper: STATUS,
  ops: { issueNfse, getNfseStatus, cancelNfse },
  idempotentOps: ['issueNfse', 'cancelNfse'],
  lookups: { findByIdempotencyKey, findByReference },
});

/** Esquece as falhas já aplicadas (o sandbox é do processo): quem reaproveita a mesma connection e a mesma chave, como os testes que repetem o cenário, recebe a falha de novo. */
const resetInjectedFaults = () => FAULTS_USED.clear();

module.exports = { FiscalSandboxContractAdapter, resetInjectedFaults };
