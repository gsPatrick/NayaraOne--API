'use strict';

const crypto = require('crypto');
const { sequelize, InvoiceRequest, InvoiceEvent, TaxDocument, CommissionEntitlement, FinancialEntry } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { isSandboxBlocked } = require('../../../utils/sandboxPolicy');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { SandboxNfseAdapter } = require('../adapters/NfseAdapter');
const { reconcile, autoResolveIfOpen } = require('./reconciliation.service');
const { getFiscalSettings } = require('../commissionSplit.service');
const { isUuid, parseMoney, isValidTaxId, safeFileName } = require('./fiscalCommon');
const { sanitizeProviderMessage } = require('../sanitizeProviderMessage');

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

// O emissor sandbox gera uma "nota" em memória: em produção isso viraria um documento fiscal falso
// gravado como oficial. Enquanto não houver emissor real configurado, produção recusa emitir.
function assertIssuerAllowed() {
  if (isSandboxBlocked() && typeof adapter.isSandbox === 'function' && adapter.isSandbox()) {
    throw AppError.unprocessable(
      'O emissor de NFS-e ainda não está configurado para produção. Configure o emissor oficial antes de emitir notas.',
      'NFSE_ISSUER_NOT_CONFIGURED'
    );
  }
}

async function appendInvoiceEvent(invoiceRequest, rawStatus, normalizedStatus, transaction, note = null) {
  await InvoiceEvent.create(
    {
      groupId: invoiceRequest.groupId,
      companyId: invoiceRequest.companyId,
      invoiceRequestId: invoiceRequest.id,
      rawStatus: String(rawStatus ?? '').slice(0, 32) || 'DESCONHECIDO',
      normalizedStatus,
      note: note ? String(note).slice(0, 1000) : null,
      occurredAt: new Date(),
    },
    { transaction }
  );
}

// Origens aceitas para uma NFS-e. FINANCIAL_ENTRY e COMMISSION_ENTITLEMENT são conferidas no banco;
// SERVICE_ORDER é uma ordem de serviço de outro sistema, aceita só como referência (a nota leva a descrição).
const NFSE_SOURCE_TYPES = ['FINANCIAL_ENTRY', 'COMMISSION_ENTITLEMENT', 'SERVICE_ORDER'];
const SOURCE_LABEL = { FINANCIAL_ENTRY: 'lançamento do Financeiro', COMMISSION_ENTITLEMENT: 'comissão', SERVICE_ORDER: 'ordem de serviço' };
const OPEN_STATUSES = ['REQUESTED', 'SUBMITTED', 'UNKNOWN', 'AUTHORIZED'];

// Transições válidas do ciclo da nota. Uma resposta atrasada ou incoerente do emissor que sairia disto é ignorada.
const VALID_TRANSITIONS = {
  REQUESTED: ['REQUESTED', 'SUBMITTED', 'UNKNOWN', 'AUTHORIZED', 'REJECTED', 'CANCELED'],
  UNKNOWN: ['UNKNOWN', 'SUBMITTED', 'AUTHORIZED', 'REJECTED', 'CANCELED'],
  SUBMITTED: ['SUBMITTED', 'AUTHORIZED', 'REJECTED', 'CANCELED'],
  AUTHORIZED: ['AUTHORIZED', 'CANCELED'],
  REJECTED: [],
  CANCELED: [],
};

// Transação própria e curta (a nota nasce REQUESTED e o id do emissor é gravado) para que nada se perca se a
// transação da requisição voltar. Nos testes tudo roda na transação do teste (ela nunca é confirmada).
async function runOwnTx(groupId, companyId, fn) {
  return sequelize.transaction(async (ownTx) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId }, transaction: ownTx });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId }, transaction: ownTx });
    return fn(ownTx);
  });
}
const useOwnTx = () => process.env.NODE_ENV !== 'test';

/**
 * requestInvoice — Marco 8 Fase 12. Emite uma NFS-e para uma origem genérica (ex: uma comissão
 * confirmada). Fluxo: cria InvoiceRequest REQUESTED (confirmado antes da chamada), chama o adapter (sob
 * timeout — "timeout vira UNKNOWN até nova consulta", citação literal do Caderno), grava o id do emissor
 * em transação própria e registra cada transição em InvoiceEvent (append-only).
 */
async function requestInvoice(payload, actorUserId, groupId, companyId, transaction) {
  assertIssuerAllowed();
  const sourceType = typeof payload?.sourceType === 'string' ? payload.sourceType.trim() : '';
  const sourceId = typeof payload?.sourceId === 'string' ? payload.sourceId.trim().toLowerCase() : '';
  const description = typeof payload?.description === 'string' ? payload.description.trim() : '';
  if (!sourceType || !sourceId) {
    throw AppError.badRequest('Os campos "sourceType" e "sourceId" são obrigatórios.', 'NFSE_VALIDATION');
  }
  if (!NFSE_SOURCE_TYPES.includes(sourceType)) {
    throw AppError.badRequest(`A origem da nota não é aceita. Use: ${NFSE_SOURCE_TYPES.map((t) => `${t} (${SOURCE_LABEL[t]})`).join(', ')}.`, 'NFSE_VALIDATION');
  }
  if (!isUuid(sourceId)) {
    throw AppError.badRequest('O campo "sourceId" precisa ser o identificador (UUID) da origem da nota.', 'NFSE_VALIDATION');
  }
  const amount = parseMoney(payload?.amount, 'O campo "amount"', 'NFSE_VALIDATION');
  if (!description) {
    throw AppError.badRequest('O campo "description" é obrigatório.', 'NFSE_VALIDATION');
  }
  if (description.length > 2000) {
    throw AppError.badRequest('A descrição da nota deve ter no máximo 2000 caracteres.', 'NFSE_VALIDATION');
  }
  // Tomador (quem recebe a nota): opcional, mas se vier precisa ser um CPF/CNPJ válido.
  let takerTaxId = null;
  if (payload?.takerTaxId !== undefined && payload?.takerTaxId !== null && payload?.takerTaxId !== '') {
    takerTaxId = String(payload.takerTaxId).replace(/\D/g, '');
    if (!isValidTaxId(takerTaxId)) {
      throw AppError.badRequest('O CPF/CNPJ do tomador da nota não é válido.', 'NFSE_VALIDATION');
    }
  }
  const takerName = typeof payload?.takerName === 'string' && payload.takerName.trim() ? payload.takerName.trim().slice(0, 150) : null;

  // Nota de comissão só nasce de uma comissão que existe nesta empresa e já virou recebível: não se
  // emite nota para comissão só prevista (EXPECTED) nem estornada (ADJUSTED). O valor da nota pode
  // diferir (e aí a reconciliação abre a divergência), mas a origem tem de ser real.
  // Nota de um lançamento do Financeiro: o lançamento precisa existir nesta empresa e estar de pé (a conferência
  // "Financeiro × NFS-e" compara o valor da nota com o do lançamento).
  if (sourceType === 'FINANCIAL_ENTRY') {
    const entry = await FinancialEntry.findOne({ where: { id: sourceId, groupId, companyId }, attributes: ['id', 'status'], transaction });
    if (!entry) {
      throw AppError.unprocessable('O lançamento financeiro informado como origem da nota não existe nesta empresa.', 'NFSE_SOURCE_NOT_FOUND');
    }
    if (['REVERSED', 'CANCELLED'].includes(entry.status)) {
      throw AppError.unprocessable('O lançamento financeiro foi estornado ou cancelado: não há nota a emitir para ele.', 'NFSE_SOURCE_NOT_READY');
    }
  }
  if (sourceType === 'COMMISSION_ENTITLEMENT') {
    const entitlement = await CommissionEntitlement.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    if (!entitlement) {
      throw AppError.unprocessable('A comissão informada como origem da nota não existe nesta empresa.', 'NFSE_SOURCE_NOT_FOUND');
    }
    if (!['CONFIRMED', 'RECEIVABLE', 'RECEIVED'].includes(entitlement.status)) {
      throw AppError.unprocessable(
        'A comissão ainda não foi confirmada (ou foi estornada): só uma comissão a receber ou recebida pode ter nota emitida.',
        'NFSE_SOURCE_NOT_READY'
      );
    }
  }

  // Deduplicação: já existe um pedido "em andamento" (não REJECTED/CANCELED) pra essa mesma
  // origem? Retorna o existente (marcado como reaproveitado) em vez de criar um segundo — mesmo espírito da
  // idempotência de submissão (Fase 5) e confirmação de comissão (Fase 8). Protegido também a nível de banco
  // pelo índice único parcial `invoice_requests_source_dedup_unique`.
  const reuse = (row) => {
    if (Math.round(Number(row.amount) * 100) !== Math.round(amount * 100)) {
      throw AppError.conflict(
        `Já existe uma NFS-e ${row.status === 'AUTHORIZED' ? 'autorizada' : 'em andamento'} para esta origem, no valor de R$ ${Number(row.amount).toFixed(2)}. Para emitir com outro valor, cancele ou conclua a anterior.`,
        'NFSE_ALREADY_REQUESTED_DIFFERENT_AMOUNT'
      );
    }
    row.setDataValue('reused', true);
    return row;
  };
  const existing = await InvoiceRequest.findOne({ where: { companyId, sourceType, sourceId, status: OPEN_STATUSES }, transaction });
  if (existing) return reuse(existing);

  // Chave de idempotência determinística pela origem e pelo número da tentativa (gravado na nota): se o emissor
  // aceitar e o processo cair antes do commit, o retry usa a MESMA chave e o emissor devolve a mesma nota.
  const attempt = await InvoiceRequest.count({ where: { companyId, sourceType, sourceId }, transaction });
  const issuerKey = `nfse:${companyId}:${sourceType}:${sourceId}:n${attempt}`;
  const fiscal = await getFiscalSettings(groupId, companyId, actorUserId, transaction);
  const createValues = {
    groupId, companyId, sourceType, sourceId, status: 'REQUESTED', adapterVersion: adapter.version(),
    attemptNumber: attempt, amount, description, createdBy: actorUserId || null, updatedBy: actorUserId || null,
  };
  let invoiceRequest;
  try {
    if (useOwnTx()) {
      const createdId = await runOwnTx(groupId, companyId, async (ownTx) => {
        const created = await InvoiceRequest.create(createValues, { transaction: ownTx });
        await appendInvoiceEvent(created, 'REQUESTED', 'REQUESTED', ownTx);
        return created.id;
      });
      invoiceRequest = await InvoiceRequest.findByPk(createdId, { transaction });
    } else {
      // Savepoint: dois pedidos simultâneos para a mesma origem não deixam a transação abortada.
      invoiceRequest = await sequelize.transaction({ transaction }, (savepoint) => InvoiceRequest.create(createValues, { transaction: savepoint }));
      await appendInvoiceEvent(invoiceRequest, 'REQUESTED', 'REQUESTED', transaction);
    }
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      const winner = await InvoiceRequest.findOne({ where: { companyId, sourceType, sourceId, status: OPEN_STATUSES }, transaction });
      if (winner) return reuse(winner);
    }
    throw err;
  }

  // Só a chamada ao emissor é ambígua (timeout/erro vira UNKNOWN). Falha de banco depois dela sobe como erro.
  let issuerResult = null;
  let issuerError = null;
  try {
    issuerResult = await withTimeout(
      adapter.requestInvoice({ idempotencyKey: issuerKey, amount, description, serviceCode: fiscal.nfseServiceCode || null, issRatePct: fiscal.nfseIssRatePct || null, takerTaxId, takerName }),
      NFSE_TIMEOUT_MS
    );
  } catch (err) {
    issuerError = err;
  }
  if (!issuerError && (!issuerResult || !issuerResult.externalId || String(issuerResult.externalId).length > 128)) {
    issuerError = new Error('O emissor respondeu sem um identificador válido para a nota.');
  }
  if (!issuerError) {
    const persist = async (tx) => {
      const row = await InvoiceRequest.findByPk(invoiceRequest.id, { transaction: tx, lock: tx.LOCK.UPDATE });
      row.status = issuerResult.status === 'AUTHORIZED' ? 'SUBMITTED' : (issuerResult.status || 'SUBMITTED');
      row.externalId = String(issuerResult.externalId);
      row.updatedBy = actorUserId || null;
      await row.save({ transaction: tx });
      await appendInvoiceEvent(row, issuerResult.status || 'SUBMITTED', row.status, tx);
    };
    // O id do emissor é gravado e confirmado na hora (transação própria): se a requisição voltar depois, a nota
    // continua ligada ao pedido do emissor.
    if (useOwnTx()) await runOwnTx(groupId, companyId, persist); else await persist(transaction);
    await invoiceRequest.reload({ transaction });
  } else {
    const err = issuerError;
    const persistUnknown = async (tx) => {
      const row = await InvoiceRequest.findByPk(invoiceRequest.id, { transaction: tx, lock: tx.LOCK.UPDATE });
      row.status = 'UNKNOWN';
      await row.save({ transaction: tx });
      await appendInvoiceEvent(row, 'UNKNOWN', null, tx, `Resposta incerta do emissor (${err instanceof NfseTimeoutError ? 'tempo esgotado' : 'erro'}).`);
    };
    if (useOwnTx()) await runOwnTx(groupId, companyId, persistUnknown); else await persistUnknown(transaction);
    await invoiceRequest.reload({ transaction });
    await registrarAuditoria(
      {
        groupId, companyId, actorUserId,
        action: 'correspondent.nfse.unknown',
        entityType: 'InvoiceRequest',
        entityId: invoiceRequest.id,
        reason: `Emissão de NFS-e ficou incerta (${err instanceof NfseTimeoutError ? 'tempo esgotado' : 'erro'}): ${sanitizeProviderMessage(err.message)}`,
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
      reason: `NFS-e solicitada para ${SOURCE_LABEL[sourceType]} ${sourceId} — R$ ${amount.toFixed(2)}.`,
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
  if (!isUuid(String(invoiceRequestId || ''))) {
    throw AppError.badRequest('Identificador de NFS-e inválido.', 'NFSE_VALIDATION');
  }
  // 1) Leitura SEM trava e chamadas ao emissor: nenhuma linha fica travada enquanto se espera o emissor.
  const preview = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction });
  if (!preview) {
    throw AppError.notFound('Pedido de NFS-e não encontrado.', 'NFSE_NOT_FOUND');
  }
  if (['REJECTED', 'CANCELED'].includes(preview.status)) {
    return preview; // estados finais: não há o que consultar
  }

  let lookup = null;
  if (!preview.externalId) {
    // Pedido que ficou sem id externo (a resposta do emissor se perdeu, ou a requisição caiu depois de ele aceitar):
    // consulta pela chave do pedido. Se o emissor tem o pedido, ele volta a andar; se confirma que NÃO tem, é
    // encerrado e uma nova emissão para a mesma origem fica liberada.
    if (!['UNKNOWN', 'REQUESTED'].includes(preview.status) || typeof adapter.findInvoiceByKey !== 'function') {
      throw AppError.badRequest('Pedido de NFS-e ainda não foi submetido ao emissor (sem id externo).', 'NFSE_NOT_SUBMITTED');
    }
    try {
      lookup = await withTimeout(adapter.findInvoiceByKey(`nfse:${companyId}:${preview.sourceType}:${preview.sourceId}:n${preview.attemptNumber}`), NFSE_TIMEOUT_MS);
    } catch (err) {
      throw AppError.unprocessable('Não foi possível consultar o emissor agora. Tente de novo em instantes.', 'NFSE_ISSUER_QUERY_FAILED');
    }
  }
  const externalIdToQuery = preview.externalId || (lookup?.found ? lookup.externalId : null);
  let result = null;
  if (externalIdToQuery) {
    try {
      result = await withTimeout(
        adapter.getInvoiceStatus(externalIdToQuery, { amount: preview.amount, description: preview.description }),
        NFSE_TIMEOUT_MS
      );
    } catch (err) {
      throw AppError.unprocessable('O emissor não respondeu a tempo. A nota continua como está; tente consultar de novo.', 'NFSE_ISSUER_QUERY_FAILED');
    }
    if (!result || !result.status) {
      throw AppError.unprocessable('O emissor respondeu sem informar a situação da nota. Tente consultar de novo.', 'NFSE_ISSUER_QUERY_FAILED');
    }
  }

  // 2) Agora a trava (duas consultas simultâneas não criam o documento fiscal duas vezes) e reconfirma o estado.
  const invoiceRequest = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!invoiceRequest || ['REJECTED', 'CANCELED'].includes(invoiceRequest.status)) {
    return invoiceRequest || preview;
  }
  if (!invoiceRequest.externalId) {
    if (lookup?.found) {
      invoiceRequest.externalId = lookup.externalId;
      invoiceRequest.status = 'SUBMITTED';
      invoiceRequest.updatedBy = actorUserId || null;
      await invoiceRequest.save({ transaction });
      await appendInvoiceEvent(invoiceRequest, 'SUBMITTED', 'SUBMITTED', transaction, 'Pedido localizado no emissor pela chave do pedido.');
    } else {
      // Mesma espera do envio de financiamento: dá tempo de uma resposta tardia do emissor chegar.
      const { peekEligibilityConfig } = require('../eligibility.service');
      const waitMinutes = (await peekEligibilityConfig(groupId, companyId, transaction)).unknownReleaseMinutes;
      const sinceMs = Date.now() - new Date(invoiceRequest.updatedAt ?? invoiceRequest.get('updated_at')).getTime();
      if (Number.isInteger(waitMinutes) && sinceMs < waitMinutes * 60000) {
        throw AppError.conflict(`A emissão ainda pode estar em andamento no emissor. Aguarde mais ${Math.max(1, Math.ceil((waitMinutes * 60000 - sinceMs) / 60000))} minuto(s) antes de liberar uma nova emissão (tempo definido em Parâmetros).`, 'NFSE_UNKNOWN_TOO_RECENT');
      }
      invoiceRequest.status = 'CANCELED';
      invoiceRequest.updatedBy = actorUserId || null;
      await invoiceRequest.save({ transaction });
      await appendInvoiceEvent(invoiceRequest, 'NOT_FOUND_AT_ISSUER', 'CANCELED', transaction, 'O emissor confirmou que não recebeu este pedido.');
      await registrarAuditoria(
        {
          groupId, companyId, actorUserId,
          action: 'correspondent.nfse.canceled',
          entityType: 'InvoiceRequest',
          entityId: invoiceRequest.id,
          reason: 'O emissor confirmou que não recebeu este pedido de NFS-e. Pedido encerrado; uma nova emissão para a mesma origem está liberada.',
        },
        transaction
      );
      return invoiceRequest;
    }
  }
  // Outra consulta chegou primeiro e deu o id depois da leitura inicial: sem resposta do emissor para aplicar agora.
  if (!result) return invoiceRequest;

  const rawStatus = String(result.rawProviderStatus || result.status).slice(0, 32);
  // Resposta que sairia do ciclo válido (ex.: nota autorizada que "volta" a enviada ou vira recusada) é ignorada,
  // com rastro: nunca altera a nota em silêncio.
  if (!(VALID_TRANSITIONS[invoiceRequest.status] || []).includes(result.status)) {
    await registrarAuditoria(
      {
        groupId, companyId, actorUserId,
        action: 'correspondent.nfse.response_ignored',
        entityType: 'InvoiceRequest',
        entityId: invoiceRequest.id,
        reason: `Resposta do emissor ignorada: a nota está ${invoiceRequest.status} e o emissor informou ${result.status} (mudança fora do ciclo válido).`,
      },
      transaction
    );
    return invoiceRequest;
  }
  // Autorização incompleta (sem número oficial ou sem XML): não vira documento fiscal; a nota segue como está e fica o rastro.
  if (result.status === 'AUTHORIZED' && invoiceRequest.status !== 'AUTHORIZED'
    && (!result.officialNumber || String(result.officialNumber).length > 64 || !result.documents?.xml)) {
    // A resposta devolve erro e a transação volta: o rastro sobrevive ao rollback pelo middleware de tenant.
    transaction.afterRollbackAudits = [...(transaction.afterRollbackAudits || []), {
      groupId, companyId, actorUserId,
      action: 'correspondent.nfse.authorization_incomplete',
      entityType: 'InvoiceRequest',
      entityId: invoiceRequest.id,
      reason: 'O emissor informou a nota como autorizada, mas sem número oficial válido ou sem o XML. A nota não foi marcada como autorizada; consulte de novo ou fale com o emissor.',
    }];
    throw AppError.unprocessable('O emissor autorizou a nota sem enviar o número oficial ou o XML. Consulte de novo em instantes.', 'NFSE_ISSUER_INCOMPLETE_AUTHORIZATION');
  }
  const wasAuthorized = invoiceRequest.status === 'AUTHORIZED';
  const statusChanged = invoiceRequest.status !== result.status;
  invoiceRequest.status = result.status;
  invoiceRequest.updatedBy = actorUserId || null;
  if (result.status === 'REJECTED') {
    invoiceRequest.rejectionReason = String(result.rejectionReason || 'O emissor não informou o motivo da recusa.').slice(0, 2000);
  }
  await invoiceRequest.save({ transaction });
  // Consultar de novo a mesma nota sem mudança não enche o histórico de eventos.
  if (statusChanged) await appendInvoiceEvent(invoiceRequest, rawStatus, result.status, transaction, result.status === 'REJECTED' ? invoiceRequest.rejectionReason : null);
  if (wasAuthorized && result.status === 'CANCELED') {
    // O emissor cancelou uma nota já exportada: a exportação ganha o ajuste (como no cancelamento feito aqui).
    const { zeroOutExportedSource: zeroOut } = require('./accountingExport.service');
    await zeroOut('NFSE', invoiceRequest.id, 'NFS-e cancelada no emissor (descoberto pela consulta)', actorUserId, groupId, companyId, transaction);
    await autoResolveIfOpen('FINANCE_X_NFSE', invoiceRequest.id, actorUserId, groupId, companyId, transaction, 'a nota foi cancelada no emissor');
  }

  if (result.status === 'REJECTED') {
    await registrarAuditoria(
      {
        groupId, companyId, actorUserId,
        action: 'correspondent.nfse.rejected',
        entityType: 'InvoiceRequest',
        entityId: invoiceRequest.id,
        reason: `NFS-e recusada pelo emissor: ${invoiceRequest.rejectionReason} Uma nova solicitação para a mesma origem é permitida.`,
      },
      transaction
    );
  }

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
          verificationCode: docs.verificationCode ? String(docs.verificationCode).slice(0, 64) : null,
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
 * InvoiceEvent (com o motivo).
 */
async function cancelInvoice(invoiceRequestId, reasonText, actorUserId, groupId, companyId, transaction) {
  if (!isUuid(String(invoiceRequestId || ''))) {
    throw AppError.badRequest('Identificador de NFS-e inválido.', 'NFSE_VALIDATION');
  }
  // Leitura SEM trava, chamada ao emissor, e só depois a trava com nova conferência: dois cliques seguidos
  // não geram dois ajustes, e a chamada externa não segura a linha da nota.
  const preview = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction });
  if (!preview) {
    throw AppError.notFound('Pedido de NFS-e não encontrado.', 'NFSE_NOT_FOUND');
  }
  if (preview.status !== 'AUTHORIZED') {
    throw AppError.conflict('Só é possível cancelar uma NFS-e já autorizada.', 'NFSE_NOT_AUTHORIZED');
  }
  const reason = typeof reasonText === 'string' ? reasonText.trim() : '';
  if (!reason) {
    throw AppError.badRequest('O cancelamento de uma NFS-e exige um motivo documentado.', 'NFSE_CANCEL_REASON_REQUIRED');
  }
  if (reason.length < 3 || reason.length > 500) {
    throw AppError.badRequest('O motivo do cancelamento deve ter entre 3 e 500 caracteres.', 'NFSE_CANCEL_REASON_REQUIRED');
  }
  // Prazo máximo para cancelar (parâmetro da empresa; 0 = sem prazo): contado da emissão da nota.
  const { nfseCancelMaxDays } = await getFiscalSettings(groupId, companyId, actorUserId, transaction);
  if (nfseCancelMaxDays > 0) {
    const doc = await TaxDocument.findOne({ where: { invoiceRequestId: preview.id, groupId, companyId }, attributes: ['issuedAt'], transaction });
    const issuedAt = doc?.issuedAt ? new Date(doc.issuedAt) : new Date(preview.updatedAt ?? preview.get('updated_at'));
    const elapsedDays = (Date.now() - issuedAt.getTime()) / 86400000;
    if (elapsedDays > nfseCancelMaxDays) {
      throw AppError.unprocessable(`O prazo para cancelar esta NFS-e (${nfseCancelMaxDays} dia(s) depois da emissão, definido em Parâmetros) já passou.`, 'NFSE_CANCEL_DEADLINE_PASSED');
    }
  }

  try {
    await withTimeout(adapter.cancelInvoice(preview.externalId), NFSE_TIMEOUT_MS);
  } catch (err) {
    // A requisição devolve erro e a transação volta: o rastro sobrevive ao rollback pelo middleware de tenant.
    if (transaction) {
      transaction.afterRollbackAudits = [...(transaction.afterRollbackAudits || []), { groupId, companyId, actorUserId, action: 'correspondent.nfse.cancel_no_response', entityType: 'InvoiceRequest', entityId: preview.id, reason: 'O emissor não respondeu ao cancelamento: a nota continua autorizada aqui, mas o emissor pode ter cancelado. Consulte o emissor antes de tentar de novo.' }];
    }
    throw AppError.unprocessable('O emissor não respondeu ao cancelamento. A nota continua autorizada aqui, mas o emissor pode ter cancelado: consulte antes de tentar de novo.', 'NFSE_ISSUER_QUERY_FAILED');
  }
  const invoiceRequest = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (invoiceRequest.status === 'CANCELED') return invoiceRequest; // outro clique já cancelou
  if (invoiceRequest.status !== 'AUTHORIZED') {
    throw AppError.conflict('Esta NFS-e mudou enquanto o cancelamento era feito. Atualize a tela.', 'NFSE_NOT_AUTHORIZED');
  }
  invoiceRequest.status = 'CANCELED';
  invoiceRequest.updatedBy = actorUserId || null;
  await invoiceRequest.save({ transaction });
  await appendInvoiceEvent(invoiceRequest, 'CANCELED', 'CANCELED', transaction, reason);

  // Nota já exportada ao contador e depois cancelada: gera a linha de ajuste na exportação (nunca em silêncio).
  const { zeroOutExportedSource } = require('./accountingExport.service');
  await zeroOutExportedSource('NFSE', invoiceRequest.id, `NFS-e cancelada: ${reason}`, actorUserId, groupId, companyId, transaction);
  // A divergência "Financeiro × NFS-e" desta nota perde o sentido: encerra junto com o cancelamento.
  await autoResolveIfOpen('FINANCE_X_NFSE', invoiceRequest.id, actorUserId, groupId, companyId, transaction, 'a nota foi cancelada');

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.nfse.canceled',
      entityType: 'InvoiceRequest',
      entityId: invoiceRequest.id,
      reason: `NFS-e cancelada: ${reason}.`,
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
  if (invoiceRequest.sourceType === 'FINANCIAL_ENTRY') {
    const entry = await FinancialEntry.findOne({ where: { id: invoiceRequest.sourceId, groupId, companyId }, transaction });
    const expectedEntry = !entry || ['REVERSED', 'CANCELLED'].includes(entry.status) ? 0 : Number(entry.amount);
    return reconcile('FINANCE_X_NFSE', invoiceRequest.id, expectedEntry, Number(invoiceRequest.amount), actorUserId, groupId, companyId, transaction);
  }
  if (invoiceRequest.sourceType !== 'COMMISSION_ENTITLEMENT') return null;
  const entitlement = await CommissionEntitlement.findOne({ where: { id: invoiceRequest.sourceId, groupId, companyId }, transaction });
  const expected = !entitlement || entitlement.status === 'ADJUSTED' ? 0 : Number(entitlement.amount);
  return reconcile('FINANCE_X_NFSE', invoiceRequest.id, expected, Number(invoiceRequest.amount), actorUserId, groupId, companyId, transaction);
}

async function listInvoiceRequests(groupId, companyId, transaction, { limit, offset } = {}) {
  const take = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 500);
  const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const invoices = await InvoiceRequest.findAll({
    where: { groupId, companyId },
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit: take,
    offset: skip,
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
 * Todo download deixa rastro (quem baixou, qual arquivo, qual hash).
 */
async function getInvoiceFile(invoiceRequestId, kind, groupId, companyId, transaction, actorUserId = null) {
  if (!isUuid(String(invoiceRequestId || ''))) {
    throw AppError.badRequest('Identificador de NFS-e inválido.', 'NFSE_VALIDATION');
  }
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
  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.nfse.file_downloaded',
      entityType: 'InvoiceRequest',
      entityId: invoiceRequest.id,
      reason: `Arquivo ${kind.toUpperCase()} da NFS-e ${doc.documentNumber || invoiceRequest.id} baixado (hash ${actualHash}).`,
    },
    transaction
  );
  return {
    buffer,
    sha256: actualHash,
    contentType: kind === 'xml' ? 'application/xml; charset=utf-8' : 'application/pdf',
    fileName: `${safeFileName(doc.documentNumber, 'nfse')}.${kind}`,
  };
}

async function getInvoiceEvents(invoiceRequestId, groupId, companyId, transaction) {
  if (!isUuid(String(invoiceRequestId || ''))) {
    throw AppError.badRequest('Identificador de NFS-e inválido.', 'NFSE_VALIDATION');
  }
  const invoiceRequest = await InvoiceRequest.findOne({ where: { id: invoiceRequestId, groupId, companyId }, transaction });
  if (!invoiceRequest) {
    throw AppError.notFound('Pedido de NFS-e não encontrado.', 'NFSE_NOT_FOUND');
  }
  return InvoiceEvent.findAll({
    where: { invoiceRequestId, groupId, companyId },
    order: [['occurred_at', 'DESC'], ['id', 'ASC']],
    limit: 500,
    transaction,
  });
}

module.exports = {
  NFSE_SOURCE_TYPES,
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
