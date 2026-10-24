'use strict';

const crypto = require('crypto');
const { InvoiceRequest, InvoiceEvent, TaxDocument, CommissionEntitlement } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { SandboxNfseAdapter } = require('../adapters/NfseAdapter');
const { reconcile } = require('./reconciliation.service');

const adapter = new SandboxNfseAdapter();

// Mesma decisão de engenharia da Fase 5 (SUBMIT_TIMEOUT_MS): tempo máximo aguardando o
// "provedor" de NFS-e antes de considerar a chamada ambígua (vira UNKNOWN, nunca reenvio cego).
const NFSE_TIMEOUT_MS = Number(process.env.CORRESPONDENT_NFSE_TIMEOUT_MS || 8000);

class NfseTimeoutError extends Error {
  constructor() {
    super('Tempo esgotado aguardando resposta do emissor de NFS-e.');
    this.name = 'NfseTimeoutError';
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new NfseTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function appendInvoiceEvent(invoiceRequest, rawStatus, normalizedStatus, transaction) {
  await InvoiceEvent.create(
    {
      groupId: invoiceRequest.groupId,
      companyId: invoiceRequest.companyId,
      invoiceRequestId: invoiceRequest.id,
      rawStatus,
      normalizedStatus,
      occurredAt: new Date(),
    },
    { transaction }
  );
}

/**
 * requestInvoice — Marco 8 Fase 12. Emite uma NFS-e para uma origem genérica (ex: uma comissão
 * confirmada). Fluxo: cria InvoiceRequest REQUESTED, chama o adapter (sob timeout — "timeout vira
 * UNKNOWN até nova consulta", citação literal do Caderno), e registra cada transição em
 * InvoiceEvent (append-only, nunca perde o evento bruto).
 */
async function requestInvoice(payload, actorUserId, groupId, companyId, transaction) {
  const sourceType = payload?.sourceType ? String(payload.sourceType) : null;
  const sourceId = payload?.sourceId ? String(payload.sourceId) : null;
  const amount = Number(payload?.amount);
  const description = payload?.description ? String(payload.description).trim() : '';
  if (!sourceType || !sourceId) {
    throw AppError.badRequest('Os campos "sourceType" e "sourceId" são obrigatórios.', 'NFSE_VALIDATION');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw AppError.badRequest('O campo "amount" deve ser um número positivo.', 'NFSE_VALIDATION');
  }
  if (!description) {
    throw AppError.badRequest('O campo "description" é obrigatório.', 'NFSE_VALIDATION');
  }

  // Deduplicação: já existe um pedido "em andamento" (não REJECTED/CANCELED) pra essa mesma
  // origem? Retorna o existente em vez de criar um segundo — mesmo espírito da idempotência de
  // submissão (Fase 5) e confirmação de comissão (Fase 8). Protegido também a nível de banco
  // pelo índice único parcial `invoice_requests_source_dedup_unique`.
  const existing = await InvoiceRequest.findOne({
    where: { companyId, sourceType, sourceId, status: ['REQUESTED', 'SUBMITTED', 'UNKNOWN', 'AUTHORIZED'] },
    transaction,
  });
  if (existing) {
    return existing;
  }

  const invoiceRequest = await InvoiceRequest.create(
    {
      groupId,
      companyId,
      sourceType,
      sourceId,
      status: 'REQUESTED',
      adapterVersion: adapter.version(),
      amount,
      description,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await appendInvoiceEvent(invoiceRequest, 'REQUESTED', 'REQUESTED', transaction);

  try {
    const result = await withTimeout(
      adapter.requestInvoice({ idempotencyKey: invoiceRequest.id, amount, description }),
      NFSE_TIMEOUT_MS
    );
    invoiceRequest.status = result.status; // 'SUBMITTED'
    invoiceRequest.externalId = result.externalId;
    invoiceRequest.updatedBy = actorUserId || null;
    await invoiceRequest.save({ transaction });
    await appendInvoiceEvent(invoiceRequest, result.status, result.status, transaction);
  } catch (err) {
    invoiceRequest.status = 'UNKNOWN';
    await invoiceRequest.save({ transaction });
    await appendInvoiceEvent(invoiceRequest, 'UNKNOWN', null, transaction);
    await registrarAuditoria(
      {
        groupId, companyId, actorUserId,
        action: 'correspondent.nfse.unknown',
        entityType: 'InvoiceRequest',
        entityId: invoiceRequest.id,
        reason: `Emissão de NFS-e ficou UNKNOWN (${err instanceof NfseTimeoutError ? 'timeout' : 'erro'}): ${err.message}`,
      },
      transaction
    );
  }

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.nfse.requested',
      entityType: 'InvoiceRequest',
      entityId: invoiceRequest.id,
      reason: `NFS-e solicitada para ${sourceType} ${sourceId} — R$ ${amount.toFixed(2)}.`,
    },
    transaction
  );

  return invoiceRequest;
}

/**
 * checkInvoiceStatus — consulta o status real no "provedor" (nunca reenvio cego: isso é exigido
 * antes de qualquer nova tentativa quando o pedido está UNKNOWN). Se AUTHORIZED, cria o
 * TaxDocument preservando o número oficial.
 */
async function checkInvoiceStatus(invoiceRequestId, actorUserId, groupId, companyId, transaction) {
  const invoiceRequest = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction });
  if (!invoiceRequest) {
    throw AppError.notFound('Pedido de NFS-e não encontrado.', 'NFSE_NOT_FOUND');
  }
  if (!invoiceRequest.externalId) {
    throw AppError.badRequest('Pedido de NFS-e ainda não foi submetido ao emissor (sem id externo).', 'NFSE_NOT_SUBMITTED');
  }

  const result = await adapter.getInvoiceStatus(invoiceRequest.externalId, {
    amount: invoiceRequest.amount,
    description: invoiceRequest.description,
  });
  invoiceRequest.status = result.status;
  invoiceRequest.updatedBy = actorUserId || null;
  await invoiceRequest.save({ transaction });
  await appendInvoiceEvent(invoiceRequest, result.rawProviderStatus, result.status, transaction);

  if (result.status === 'AUTHORIZED') {
    // Reusa "finance"."tax_documents" (scaffold já existente desde a migration 057, estendido
    // com invoice_request_id na 351) — nunca duplica tabela. documentType='NFSE' é o único tipo
    // que este fluxo emite; DIMOB usa suas próprias tabelas (dimob_batches/records).
    const existing = await TaxDocument.findOne({ where: { invoiceRequestId: invoiceRequest.id }, transaction });
    if (!existing) {
      const docs = result.documents || {};
      const taxDocument = await TaxDocument.create(
        {
          groupId, companyId,
          invoiceRequestId: invoiceRequest.id,
          documentType: 'NFSE',
          documentNumber: result.officialNumber,
          amount: invoiceRequest.amount,
          issuedAt: docs.issuedAt || new Date(),
          // XML, PDF e ID oficial preservados com hash (Caderno: "XML/PDF/ID oficial preservados").
          xmlContent: docs.xml || null,
          xmlSha256: docs.xml ? crypto.createHash('sha256').update(docs.xml).digest('hex') : null,
          pdfContent: docs.pdf || null,
          pdfSha256: docs.pdf ? crypto.createHash('sha256').update(docs.pdf).digest('hex') : null,
          verificationCode: docs.verificationCode || null,
        },
        { transaction }
      );
      await registrarAuditoria(
        {
          groupId, companyId, actorUserId,
          action: 'correspondent.nfse.authorized',
          entityType: 'InvoiceRequest',
          entityId: invoiceRequest.id,
          reason: `NFS-e ${result.officialNumber} autorizada; XML (${taxDocument.xmlSha256 || 'sem xml'}) e PDF (${taxDocument.pdfSha256 || 'sem pdf'}) preservados.`,
        },
        transaction
      );
      await reconcileInvoiceWithSource(invoiceRequest, actorUserId, groupId, companyId, transaction);
    }
  }

  return invoiceRequest;
}

/**
 * cancelInvoice — NFS-e já autorizada pode ser cancelada; nunca apaga o InvoiceRequest nem o
 * TaxDocument emitido (preserva número oficial, citação literal do Caderno) — o estado de
 * cancelamento vive só em `InvoiceRequest.status`, registrado também no histórico append-only de
 * InvoiceEvent.
 */
async function cancelInvoice(invoiceRequestId, reasonText, actorUserId, groupId, companyId, transaction) {
  const invoiceRequest = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction });
  if (!invoiceRequest) {
    throw AppError.notFound('Pedido de NFS-e não encontrado.', 'NFSE_NOT_FOUND');
  }
  if (invoiceRequest.status !== 'AUTHORIZED') {
    throw AppError.conflict('Só é possível cancelar uma NFS-e já autorizada.', 'NFSE_NOT_AUTHORIZED');
  }
  if (!reasonText || !String(reasonText).trim()) {
    throw AppError.badRequest('O cancelamento de uma NFS-e exige um motivo documentado.', 'NFSE_CANCEL_REASON_REQUIRED');
  }

  await adapter.cancelInvoice(invoiceRequest.externalId);
  invoiceRequest.status = 'CANCELED';
  invoiceRequest.updatedBy = actorUserId || null;
  await invoiceRequest.save({ transaction });
  await appendInvoiceEvent(invoiceRequest, 'CANCELED', 'CANCELED', transaction);

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.nfse.canceled',
      entityType: 'InvoiceRequest',
      entityId: invoiceRequest.id,
      reason: `NFS-e cancelada: ${reasonText}.`,
    },
    transaction
  );

  return invoiceRequest;
}

/**
 * reconcileInvoiceWithSource — Financeiro × NFS-e: compara o valor da nota com o valor que o
 * Financeiro reconhece para a origem. Diferença abre issue (reconciliação), nunca é silenciosa.
 * Origem COMMISSION_ENTITLEMENT: esperado = valor da comissão (zero se estornada).
 */
async function reconcileInvoiceWithSource(invoiceRequest, actorUserId, groupId, companyId, transaction) {
  if (invoiceRequest.sourceType !== 'COMMISSION_ENTITLEMENT') return null;
  const entitlement = await CommissionEntitlement.findOne({ where: { id: invoiceRequest.sourceId, groupId, companyId }, transaction });
  if (!entitlement) return null;
  const expected = entitlement.status === 'ADJUSTED' ? 0 : Number(entitlement.amount);
  return reconcile('FINANCE_X_NFSE', invoiceRequest.id, expected, Number(invoiceRequest.amount), actorUserId, groupId, companyId, transaction);
}

async function listInvoiceRequests(groupId, companyId, transaction) {
  const invoices = await InvoiceRequest.findAll({
    where: { groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
  const docs = await TaxDocument.findAll({
    where: { groupId, companyId, invoiceRequestId: invoices.map((i) => i.id) },
    attributes: ['id', 'invoiceRequestId', 'documentNumber', 'verificationCode', 'xmlSha256', 'pdfSha256', 'issuedAt'],
    transaction,
  });
  const byInvoice = new Map(docs.map((d) => [d.invoiceRequestId, d]));
  return invoices.map((invoice) => {
    const json = invoice.toJSON();
    const doc = byInvoice.get(invoice.id);
    json.document = doc
      ? {
          documentNumber: doc.documentNumber,
          verificationCode: doc.verificationCode,
          issuedAt: doc.issuedAt,
          hasXml: Boolean(doc.xmlSha256),
          hasPdf: Boolean(doc.pdfSha256),
          xmlSha256: doc.xmlSha256,
          pdfSha256: doc.pdfSha256,
        }
      : null;
    return json;
  });
}

/**
 * getInvoiceFile — devolve o XML ou PDF oficial preservado, conferindo o hash gravado na emissão.
 */
async function getInvoiceFile(invoiceRequestId, kind, groupId, companyId, transaction) {
  const invoiceRequest = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction });
  if (!invoiceRequest) {
    throw AppError.notFound('Pedido de NFS-e não encontrado.', 'NFSE_NOT_FOUND');
  }
  const doc = await TaxDocument.findOne({ where: { invoiceRequestId, groupId, companyId }, transaction });
  if (!doc) {
    throw AppError.notFound('Esta NFS-e ainda não foi autorizada — não há XML/PDF para baixar.', 'NFSE_DOCUMENT_NOT_AVAILABLE');
  }
  const content = kind === 'xml' ? doc.xmlContent : doc.pdfContent;
  const expectedHash = kind === 'xml' ? doc.xmlSha256 : doc.pdfSha256;
  if (!content) {
    throw AppError.notFound(`O arquivo ${kind.toUpperCase()} desta NFS-e não foi preservado.`, 'NFSE_DOCUMENT_NOT_AVAILABLE');
  }
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedHash && actualHash !== expectedHash) {
    throw AppError.unprocessable('O arquivo preservado não confere com o hash gravado na emissão.', 'NFSE_DOCUMENT_HASH_MISMATCH');
  }
  return {
    buffer,
    sha256: actualHash,
    contentType: kind === 'xml' ? 'application/xml; charset=utf-8' : 'application/pdf',
    fileName: `${doc.documentNumber || 'nfse'}.${kind}`,
  };
}

async function getInvoiceEvents(invoiceRequestId, groupId, companyId, transaction) {
  const invoiceRequest = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction });
  if (!invoiceRequest) {
    throw AppError.notFound('Pedido de NFS-e não encontrado.', 'NFSE_NOT_FOUND');
  }
  return InvoiceEvent.findAll({
    where: { invoiceRequestId, groupId, companyId },
    order: [['occurred_at', 'DESC']],
    transaction,
  });
}

module.exports = {
  requestInvoice,
  checkInvoiceStatus,
  cancelInvoice,
  listInvoiceRequests,
  getInvoiceEvents,
  getInvoiceFile,
  reconcileInvoiceWithSource,
  withTimeout,
  NfseTimeoutError,
};
