'use strict';

const { SignatureEnvelope, Signature, ContractVersion, IntegrationConnection, IntegrationDispatch } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const dispatchService = require('../../../../features/integrations/dispatch/enqueue/dispatch.service');
const { compensateDispatch } = require('../../../../features/integrations/domain');
const contingency = require('../../../../features/integrations/contingency');
const contractsService = require('../../contracts/application/contract.service');
const { loadSigners } = require('./signature.signers');
const { sendNow } = require('./signature.request');

const QUEUED = ['PENDING', 'RETRY_WAIT'];

const requiresApproval = () => AppError.forbidden('A troca de fornecedor nesta operação exige aprovação humana.', 'INTEGRATION_ALTERNATE_REQUIRES_APPROVAL');
const notPending = () => AppError.conflict('Só um envelope pendente, com o contrato em assinatura, pode trocar de fornecedor.', 'LEGAL_SIGNATURE_ENVELOPE_NOT_SWITCHABLE');

/** Religa o envelope ao envio e à connection novos quando o framework de contingência leva o `createEnvelope` da fila para o alternativo (nada tinha chegado ao fornecedor). */
async function onEnvelopeDispatchMoved(ctx, { from, to, alternate }, transaction) {
  const envelope = await SignatureEnvelope.findOne({ where: { dispatchId: from.id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!envelope) return null;
  await envelope.update({ connectionId: alternate.id, providerCode: alternate.providerCode, dispatchId: to.id }, { transaction });
  return envelope;
}

/** Novo envelope no alternativo com os signatários que ainda não assinaram; as assinaturas pendentes passam a pertencer a ele. */
async function createReplacement(ctx, { old, alt, version, contract, pendentes, actorUserId }, transaction) {
  const signers = await loadSigners(pendentes.map((s) => s.personId), contract.id, transaction);
  const { dispatch } = await dispatchService.enqueue({
    companyId: ctx.companyId, connectionId: alt.id, operation: 'createEnvelope', aggregateType: 'ContractVersion', aggregateId: version.id,
    payload: { documentRef: version.id, documentSha256: version.contentHash, signers }, idempotencyKey: `legal-signature-switch:${old.id}`, userId: actorUserId || null, transaction,
  });
  const novo = await SignatureEnvelope.create({
    groupId: old.groupId, companyId: old.companyId, contractVersionId: version.id, connectionId: alt.id, providerCode: alt.providerCode, documentSha256: old.documentSha256, status: 'PENDING', dispatchId: dispatch.id,
  }, { transaction });
  for (const s of pendentes) await s.update({ envelopeId: novo.id, externalSignatureId: null, providerEnvelopeId: null }, { transaction });
  return { novo, dispatch };
}

/**
 * Troca o fornecedor de assinatura de um envelope pendente (M9-D227 3.3 a). Operação DANGEROUS: só com aprovação humana (`approved`; a rota exige `legal:sign` e MFA recente), senão 403
 * INTEGRATION_ALTERNATE_REQUIRES_APPROVAL. O alternativo vem da política da connection e precisa ser elegível. O estado do contrato (SIGNING) e quem já assinou ficam como estão.
 *  - Nada chegou ao fornecedor (envio ainda na fila): o próprio envio vai ao alternativo e o envelope o acompanha.
 *  - O envelope já existe no fornecedor que caiu: nasce um envelope NOVO no alternativo com os signatários pendentes, o anterior vira SUPERSEDED e é cancelado por compensação (M9-D220,
 *    `cancelEnvelope` na fila do fornecedor antigo, o envio original fica intacto).
 */
async function switchSignatureProvider(ctx, { envelopeId, approved, actorUserId, now = new Date() }, transaction) {
  if (!approved) throw requiresApproval();
  const old = await SignatureEnvelope.findOne({ where: { id: envelopeId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!old) throw AppError.notFound('Envelope não encontrado.', 'LEGAL_SIGNATURE_ENVELOPE_NOT_FOUND');
  const version = await ContractVersion.findByPk(old.contractVersionId, { transaction });
  const contract = await contractsService.getContract(version.contractId, transaction);
  if (old.status !== 'PENDING' || contract.status !== 'SIGNING') throw notPending();
  const primary = await IntegrationConnection.findOne({ where: { id: old.connectionId, companyId: ctx.companyId }, transaction });
  const policy = await contingency.resolveContingencyPolicy(ctx, primary, transaction);
  const alt = await contingency.assertAlternate(ctx, primary, policy && policy.alternateConnectionId, 'createEnvelope', now, transaction);
  const pendentes = await Signature.findAll({ where: { envelopeId: old.id, status: 'PENDING' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!pendentes.length) throw notPending();
  const envio = old.dispatchId ? await IntegrationDispatch.findOne({ where: { id: old.dispatchId, companyId: ctx.companyId }, transaction }) : null;
  let resultado;
  if (!old.externalEnvelopeId && envio && QUEUED.includes(envio.status)) {
    const r = await contingency.switchToAlternate(ctx, envio.id, { approved: true, now }, transaction);
    resultado = { mode: 'QUEUE_MOVED', envelopeId: old.id, dispatchId: r.toDispatchId, connectionId: alt.id };
  } else {
    const { novo, dispatch } = await createReplacement(ctx, { old, alt, version, contract, pendentes, actorUserId }, transaction);
    await old.update({ status: 'SUPERSEDED', supersededBy: novo.id }, { transaction });
    if (envio && ['SUBMITTED', 'CONFIRMED'].includes(envio.status) && envio.externalResourceId) await compensateDispatch(ctx, envio.id, { userId: actorUserId || null, transaction });
    await sendNow(ctx, dispatch.id, transaction);
    resultado = { mode: 'NEW_ENVELOPE', envelopeId: novo.id, supersededEnvelopeId: old.id, dispatchId: dispatch.id, connectionId: alt.id };
  }
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: actorUserId || null, action: 'legal.signature.provider_switched', entityType: 'SignatureEnvelope', entityId: old.id,
    beforeJson: { providerCode: primary.providerCode, status: 'PENDING' }, afterJson: { ...resultado, providerCode: alt.providerCode, pendingSigners: pendentes.length },
    reason: 'Fornecedor de assinatura fora: troca aprovada por uma pessoa. O contrato segue em assinatura e quem já assinou mantém a evidência.',
  }, transaction);
  return resultado;
}

module.exports = { switchSignatureProvider, onEnvelopeDispatchMoved };
