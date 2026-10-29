'use strict';

const crypto = require('node:crypto');
const { Signature, SignatureEnvelope, ContractVersion, IntegrationDispatch } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const dispatchService = require('../../integrations/dispatch/enqueue/dispatch.service');
const { transitionDispatch } = require('../../integrations/dispatch/dispatch.transition');
const { processClaimed } = require('../../integrations/dispatch/worker/worker.process');
const { publishSignatureRequested } = require('../legalEvents.service');
const { ensureSignatureConnection } = require('./signature.connection');
const { loadSigners } = require('./signature.signers');
const { installEnvelopeBinder } = require('./signature.bind');

installEnvelopeBinder();

const FINAL_FAILURE = ['FAILED', 'DEAD_LETTER', 'CANCELLED', 'RETRY_WAIT'];

/** Só a versão vigente e aprovada do contrato vai para assinatura, com o hash dela (M9-D236 3.2 item 7): o hash é o que o fornecedor confirma depois. */
async function assertSignableVersion(contractVersion, transaction) {
  if (!contractVersion.contentHash) {
    throw AppError.unprocessable('A versão do contrato não tem hash do conteúdo: gere a versão novamente antes de pedir a assinatura.', 'LEGAL_SIGNATURE_VERSION_HASH_MISSING');
  }
  const vigente = await ContractVersion.findOne({ where: { contractId: contractVersion.contractId }, order: [['version_number', 'DESC']], transaction });
  if (vigente && vigente.id !== contractVersion.id) {
    throw AppError.conflict('Só a versão vigente (aprovada) do contrato pode ser enviada para assinatura.', 'LEGAL_SIGNATURE_VERSION_SUPERSEDED');
  }
}

/** Manda o envio agora (a pessoa espera o id do envelope): pega o envio PENDING e roda o worker nele, na mesma transação do pedido. */
async function sendNow(ctx, dispatchId, transaction) {
  await transitionDispatch(ctx, dispatchId, 'SENDING', {}, { motivo: 'Envio pego pelo fluxo de assinatura do Jurídico.' }, transaction);
  const resultado = await processClaimed(ctx, dispatchId, { transaction });
  const atual = await IntegrationDispatch.findOne({ where: { id: dispatchId, companyId: ctx.companyId }, transaction });
  if (FINAL_FAILURE.includes(atual.status)) {
    throw AppError.internal('O fornecedor de assinatura não aceitou o pedido de envelope.', 'LEGAL_SIGNATURE_PROVIDER_ERROR', { dispatchStatus: atual.status, code: atual.lastErrorCode || null });
  }
  return { resultado, atual };
}

/**
 * Pedido de assinatura de uma versão do contrato (M9-D236): o pedido ao fornecedor entra por `dispatchService.enqueue` (conteúdo minimizado, hash e `purpose` gravados na linha
 * de integration.dispatches). Cria o envelope e uma assinatura PENDING por signatário e roda o envio na hora; o observador (signature.bind.js) grava o id do envelope e dos
 * signatários. Fornecedor lento ou incerto (UNKNOWN) não perde nada: o envelope fica PENDING e o id se aprende pela reconciliação ou pelo primeiro evento.
 */
async function requestEnvelope(ctx, { contractVersion, contract, signerPersonIds, actorUserId }, transaction) {
  await assertSignableVersion(contractVersion, transaction);
  const connection = await ensureSignatureConnection(ctx, transaction);
  const signers = await loadSigners(signerPersonIds, contract.id, transaction);
  const { dispatch } = await dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: connection.id, operation: 'createEnvelope', aggregateType: 'ContractVersion', aggregateId: contractVersion.id,
    payload: { documentRef: contractVersion.id, documentSha256: contractVersion.contentHash, signers }, idempotencyKey: `legal-signature:${contractVersion.id}:${crypto.randomUUID()}`,
    userId: actorUserId || null, transaction,
  });
  const envelope = await SignatureEnvelope.create({
    groupId: contractVersion.groupId, companyId: contractVersion.companyId, contractVersionId: contractVersion.id, connectionId: connection.id, providerCode: connection.providerCode,
    documentSha256: contractVersion.contentHash, status: 'PENDING', dispatchId: dispatch.id,
  }, { transaction });
  const assinaturas = [];
  for (const s of signers) {
    const assinatura = await Signature.create({
      groupId: contractVersion.groupId, companyId: contractVersion.companyId, contractVersionId: contractVersion.id, personId: s.personId, status: 'PENDING', contentHash: contractVersion.contentHash,
      envelopeId: envelope.id, signerEmail: s.email || null, createdBy: actorUserId || null, updatedBy: actorUserId || null,
    }, { transaction });
    assinaturas.push(assinatura);
  }
  await sendNow(ctx, dispatch.id, transaction);
  for (const a of assinaturas) {
    await a.reload({ transaction });
    await publishSignatureRequested(a, transaction);
    await registrarAuditoria({
      groupId: contractVersion.groupId, companyId: contractVersion.companyId, actorUserId, action: 'legal.signature.request', entityType: 'Signature', entityId: a.id, afterJson: a.toJSON(),
      reason: `Assinatura solicitada (provider: ${connection.providerCode}, envio ${dispatch.id}) à pessoa ${a.personId} para a versão ${contractVersion.id} do contrato.`,
    }, transaction);
  }
  return { envelope: await envelope.reload({ transaction }), signatures: assinaturas };
}

module.exports = { requestEnvelope, assertSignableVersion, sendNow };
