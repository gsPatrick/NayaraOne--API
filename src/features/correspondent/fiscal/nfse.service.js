'use strict';

const { InvoiceRequest, InvoiceEvent, TaxDocument } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { SandboxNfseAdapter } = require('../adapters/NfseAdapter');

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

  const result = await adapter.getInvoiceStatus(invoiceRequest.externalId);
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
      await TaxDocument.create(
        {
          groupId, companyId,
          invoiceRequestId: invoiceRequest.id,
          documentType: 'NFSE',
          documentNumber: result.officialNumber,
          amount: invoiceRequest.amount,
          issuedAt: new Date(),
        },
        { transaction }
      );
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

async function listInvoiceRequests(groupId, companyId, transaction) {
  return InvoiceRequest.findAll({
    where: { groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
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
  withTimeout,
  NfseTimeoutError,
};
