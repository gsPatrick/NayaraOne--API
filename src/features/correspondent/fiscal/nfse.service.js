'use strict';

const crypto = require('crypto');
const { sequelize, InvoiceRequest, InvoiceEvent, TaxDocument, CommissionEntitlement, FinancialEntry } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { ensureFiscalConnection, adapterVersionOf } = require('./nfse/nfse.connection');
const { allocateRps } = require('./nfse/nfse.rps');
const { issueViaDispatch, enqueueIssue } = require('./nfse/nfse.issue');
const { queryInvoiceStatus, lookupIssuance, settleIssuanceDispatch, finishIssuanceDispatch, cancelAtIssuer } = require('./nfse/nfse.ops');
const { storeInvoiceFiles } = require('./nfse/nfse.files');
const { readNfseParams } = require('./nfse/nfse.params');
const { installNfseBinder } = require('./nfse/nfse.bind');
const { reconcile, autoResolveIfOpen } = require('./reconciliation.service');
const { getFiscalSettings } = require('../commissionSplit.service');
const { isUuid, parseMoney, isValidTaxId, safeFileName } = require('./fiscalCommon');

installNfseBinder(); // M9-D241: a resposta do emissor liga o pedido à nota e a reconciliação ganha o RPS

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
// `NFSE_FORCE_OWN_TX=1` liga o caminho de produção (transação própria) também no teste, para provar que a nota e o envio ao emissor nascem na mesma transação (M9-D220).
const useOwnTx = () => process.env.NODE_ENV !== 'test' || process.env.NFSE_FORCE_OWN_TX === '1';

/**
 * requestInvoice — Marco 8 Fase 12. Emite uma NFS-e para uma origem genérica (ex: uma comissão
 * confirmada). Fluxo: cria InvoiceRequest REQUESTED (confirmado antes da chamada), chama o adapter (sob
 * timeout — "timeout vira UNKNOWN até nova consulta", citação literal do Caderno), grava o id do emissor
 * em transação própria e registra cada transição em InvoiceEvent (append-only).
 */
async function requestInvoice(payload, actorUserId, groupId, companyId, transaction) {
  // M9-D241: o emissor é a connection de NFS-e da empresa (registro de integração); produção sem emissor oficial continua recusando (422 NFSE_ISSUER_NOT_CONFIGURED).
  const ctx = { groupId, companyId, userId: actorUserId || null };
  const connection = await ensureFiscalConnection(ctx, transaction);
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

  // O RPS é a chave natural da emissão (M9-D241): número único e crescente por empresa e série, gravado junto da nota; a chave de idempotência do envio sai dele. Se o emissor
  // aceitar e o processo cair antes do commit, o retry usa o MESMO RPS e o emissor devolve a mesma nota. A correção de uma nota recusada é outra nota, com outro RPS.
  const attempt = await InvoiceRequest.count({ where: { companyId, sourceType, sourceId }, transaction });
  const fiscal = await getFiscalSettings(groupId, companyId, actorUserId, transaction);
  const { rpsSeries } = await readNfseParams(ctx, transaction);
  let rps = null;
  const valuesWith = (r) => ({
    groupId, companyId, sourceType, sourceId, status: 'REQUESTED', adapterVersion: adapterVersionOf(connection),
    attemptNumber: attempt, amount, description, rpsSeries: r.series, rpsNumber: r.number, issuerKey: r.key, createdBy: actorUserId || null, updatedBy: actorUserId || null,
  });
  let invoiceRequest;
  let issueDispatchId = null;
  try {
    if (useOwnTx()) {
      const criada = await runOwnTx(groupId, companyId, async (ownTx) => {
        rps = await allocateRps(ctx, rpsSeries, ownTx);
        const created = await InvoiceRequest.create(valuesWith(rps), { transaction: ownTx });
        await appendInvoiceEvent(created, 'REQUESTED', 'REQUESTED', ownTx);
        // M9-D220: o pedido ao emissor nasce na MESMA transação da nota (os dois são confirmados juntos; nunca há nota REQUESTED sem o envio que a leva ao emissor).
        const envio = await enqueueIssue({ ctx, connection, rps, amount, description, fiscal, takerTaxId, takerName }, created, ownTx);
        return { id: created.id, dispatchId: envio.id };
      });
      issueDispatchId = criada.dispatchId;
      invoiceRequest = await InvoiceRequest.findByPk(criada.id, { transaction });
    } else {
      // Savepoint: dois pedidos simultâneos para a mesma origem não deixam a transação abortada (e o número do RPS volta junto).
      invoiceRequest = await sequelize.transaction({ transaction }, async (savepoint) => {
        rps = await allocateRps(ctx, rpsSeries, savepoint);
        return InvoiceRequest.create(valuesWith(rps), { transaction: savepoint });
      });
      await appendInvoiceEvent(invoiceRequest, 'REQUESTED', 'REQUESTED', transaction);
    }
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      const winner = await InvoiceRequest.findOne({ where: { companyId, sourceType, sourceId, status: OPEN_STATUSES }, transaction });
      if (winner) return reuse(winner);
    }
    throw err;
  }

  // O pedido ao emissor entra pelo Dispatch Service (M9-D241 3.2); ver nfse/nfse.issue.js. Resposta incerta vira UNKNOWN, nunca reenvio cego.
  await issueViaDispatch({
    ctx, connection, invoiceRequest, rps, amount, description, fiscal, takerTaxId, takerName, actorUserId, transaction, dispatchId: issueDispatchId, useOwn: useOwnTx(), timeoutMs: NFSE_TIMEOUT_MS, withTimeout, NfseTimeoutError,
    runOwn: (fn) => runOwnTx(groupId, companyId, fn), appendEvent: appendInvoiceEvent,
  });

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
  const ctx = { groupId, companyId, userId: actorUserId || null };
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
    if (!['UNKNOWN', 'REQUESTED'].includes(preview.status)) {
      throw AppError.badRequest('Pedido de NFS-e ainda não foi submetido ao emissor (sem id externo).', 'NFSE_NOT_SUBMITTED');
    }
    // M9-D241: UNKNOWN consulta o emissor pelo RPS e pela chave antes de reemitir (nunca reenvio cego), sem alterar nada enquanto não houver resposta.
    lookup = await lookupIssuance(ctx, preview, { transaction, timeoutMs: NFSE_TIMEOUT_MS, withTimeout });
  }
  const externalIdToQuery = preview.externalId || (lookup?.found ? lookup.externalId : null);
  let result = null;
  if (externalIdToQuery) {
    // A consulta de status também entra pelo Dispatch Service (SAFE); a nota achada pelo RPS ainda não tem o identificador gravado.
    const nota = preview.externalId ? preview : { ...preview.get({ plain: true }), externalId: externalIdToQuery };
    result = await queryInvoiceStatus(ctx, nota, { transaction, timeoutMs: NFSE_TIMEOUT_MS, withTimeout });
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
      await appendInvoiceEvent(invoiceRequest, 'SUBMITTED', 'SUBMITTED', transaction, 'Pedido localizado no emissor pelo RPS e pela chave do pedido.');
      await settleIssuanceDispatch(ctx, invoiceRequest, { found: true }, transaction);
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
      await settleIssuanceDispatch(ctx, invoiceRequest, { found: false }, transaction);
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
  await finishIssuanceDispatch(ctx, invoiceRequest, result, transaction); // M9-D241: o status final do emissor confirma (ou encerra) o envio da emissão
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
      // M9-D241: o XML e o PDF oficiais também ficam em `files`, cifrados e com o hash na linha do arquivo.
      const arquivos = await storeInvoiceFiles({ groupId, companyId, documentNumber: result.officialNumber, documents: docs }, transaction);
      const taxDocument = await TaxDocument.create(
        {
          groupId, companyId,
          invoiceRequestId: invoiceRequest.id,
          xmlFileId: arquivos.xmlFile ? arquivos.xmlFile.id : null,
          pdfFileId: arquivos.pdfFile ? arquivos.pdfFile.id : null,
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

  let cancelamento;
  try {
    // M9-D241: o cancelamento é DANGEROUS no Dispatch Service e só vale quando o emissor confirma o status CANCELED (consulta de status depois do pedido).
    cancelamento = await cancelAtIssuer({ groupId, companyId, userId: actorUserId || null }, preview, reason, { transaction, timeoutMs: NFSE_TIMEOUT_MS, withTimeout });
  } catch (err) {
    if (err && err.code === 'INTEGRATION_FISCAL_CANCEL_REASON_REQUIRED') throw err;
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
  if (!cancelamento.canceled) {
    // O emissor recebeu o pedido mas ainda não informa CANCELED: a nota segue autorizada aqui e a consulta de status conclui o cancelamento quando ele confirmar.
    await appendInvoiceEvent(invoiceRequest, 'CANCEL_REQUESTED', 'AUTHORIZED', transaction, reason);
    return invoiceRequest;
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
