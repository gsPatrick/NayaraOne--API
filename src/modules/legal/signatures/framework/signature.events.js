'use strict';

const { Signature, SignatureEnvelope, SignatureProviderRouting, ContractVersion, ContractParty, IntegrationDispatch } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { recordError } = require('../../../../features/integrations/errors');
const { registerDomainHandler } = require('../../../../features/integrations/webhooks/worker/worker.handlers');
const { readSignatureParams } = require('./signature.params');
const { buildEvidence, storeEvidenceFile, storeSignedFile } = require('./signature.evidence');
const { tryCompleteContract } = require('./signature.complete');
const { downloadSigned } = require('./signature.adapter');

const audit = (ctx, action, entity, entityId, reason, extra, transaction) => registrarAuditoria({
  groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action, entityType: entity, entityId, afterJson: extra || null, reason,
}, transaction);

/** Erro de integração do evento recusado, SEM o conteúdo (só ids e códigos). */
const refuse = (ctx, row, { code, message, severity, errorClass = 'VALIDATION' }, transaction) => recordError(ctx, {
  providerCode: row.providerCode, connectionId: row.connectionId || null, source: 'WEBHOOK', sourceRefId: row.id, operation: 'webhook.signature', errorClass, severity, errorCode: code, message,
  payload: { inboxId: row.id, externalEventId: row.externalEventId }, allowlist: ['inboxId', 'externalEventId'],
}, transaction);

/** O envelope do evento: pelo par (connection, id do fornecedor); senão pelo envio que o reconciliador resolveu (id ainda não aprendido); senão pelo signatário. */
async function findEnvelope(ctx, row, data, transaction) {
  const base = { companyId: ctx.companyId };
  if (data.externalEnvelopeId) {
    const doFornecedor = row.connectionId && !row.legacyAlias ? { connectionId: row.connectionId } : {}; // rota antiga do Clicksign: o envelope pode estar numa connection de outro fornecedor (fallback do sandbox); o id basta
    const achado = await SignatureEnvelope.findOne({ where: { ...base, ...doFornecedor, externalEnvelopeId: data.externalEnvelopeId }, transaction, lock: transaction.LOCK.UPDATE });
    if (achado) return achado;
    const envio = await IntegrationDispatch.findOne({ where: { ...base, connectionId: row.connectionId, operation: 'createEnvelope', externalResourceId: data.externalEnvelopeId }, transaction });
    const pendente = envio && await SignatureEnvelope.findOne({ where: { ...base, dispatchId: envio.id, externalEnvelopeId: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (pendente) {
      await pendente.update({ externalEnvelopeId: data.externalEnvelopeId }, { transaction });
      return pendente;
    }
  }
  if (data.externalSignerId) {
    const assinatura = await Signature.findOne({ where: { ...base, externalSignatureId: data.externalSignerId }, transaction });
    if (assinatura && assinatura.envelopeId) return SignatureEnvelope.findByPk(assinatura.envelopeId, { transaction, lock: transaction.LOCK.UPDATE });
  }
  return null;
}

/** Signatário previsto (M9-D236 3.2 item 3): pelo id do fornecedor e pelo e-mail, e precisa ser parte do contrato. Sem id ainda, casa pelo e-mail e aprende o id. */
async function matchSigner(ctx, envelope, data, priv, transaction) {
  const assinaturas = await Signature.findAll({ where: { envelopeId: envelope.id }, transaction, lock: transaction.LOCK.UPDATE });
  const email = priv.signerEmail ? String(priv.signerEmail).toLowerCase() : null;
  let alvo = data.externalSignerId ? assinaturas.find((s) => s.externalSignatureId === data.externalSignerId) : null;
  if (!alvo && email) alvo = assinaturas.find((s) => !s.externalSignatureId && s.signerEmail && s.signerEmail.toLowerCase() === email);
  if (!alvo) return null;
  if (alvo.signerEmail && email && alvo.signerEmail.toLowerCase() !== email) return null;
  const versao = await ContractVersion.findByPk(envelope.contractVersionId, { transaction });
  const parte = await ContractParty.findOne({ where: { contractId: versao.contractId, personId: alvo.personId }, transaction });
  return parte ? alvo : null;
}

/** Hash do conteúdo ORIGINAL confirmado pelo fornecedor diferente do enviado (M9-D236 3.2 item 2): envelope HASH_MISMATCH, contrato NÃO vai a SIGNED e abre incidente CRITICAL. */
async function markHashMismatch(ctx, row, envelope, confirmado, transaction) {
  await envelope.update({ status: 'HASH_MISMATCH', originalConfirmedSha256: confirmado }, { transaction });
  await refuse(ctx, row, { code: 'INTEGRATION_LEGAL_SIGNATURE_HASH_MISMATCH', message: 'O documento assinado não corresponde à versão enviada.', severity: 'CRITICAL', errorClass: 'SECURITY' }, transaction);
  await audit(ctx, 'legal.signature.hash_mismatch', 'SignatureEnvelope', envelope.id, 'O fornecedor confirmou um hash diferente do enviado: o contrato não vai a SIGNED.', { enviado: envelope.documentSha256, confirmado }, transaction);
}

async function onSignerSigned(ctx, row, ev, envelope, transaction) {
  const { data } = ev;
  const priv = ev.private || {};
  if (envelope.status !== 'PENDING') {
    await audit(ctx, 'legal.signature.event_ignored', 'SignatureEnvelope', envelope.id, `Assinatura ignorada: o envelope está ${envelope.status} e não reabre.`, null, transaction);
    return { applied: false };
  }
  const alvo = await matchSigner(ctx, envelope, data, priv, transaction);
  if (!alvo) {
    await refuse(ctx, row, { code: 'INTEGRATION_LEGAL_SIGNER_NOT_EXPECTED', message: 'Assinatura de pessoa não prevista no envelope.', severity: 'HIGH', errorClass: 'SECURITY' }, transaction);
    await audit(ctx, 'legal.signature.signer_not_expected', 'SignatureEnvelope', envelope.id, 'Assinatura recusada: signatário não previsto no envelope ou fora das partes do contrato.', null, transaction);
    return { applied: false };
  }
  if (priv.originalSha256 && priv.originalSha256 !== envelope.documentSha256) {
    await markHashMismatch(ctx, row, envelope, priv.originalSha256, transaction);
    return { applied: true };
  }
  if (alvo.status === 'SIGNED') return { applied: false };
  if (!alvo.externalSignatureId && data.externalSignerId) {
    await alvo.update({ externalSignatureId: data.externalSignerId, providerEnvelopeId: envelope.externalEnvelopeId }, { transaction });
    await SignatureProviderRouting.findOrCreate({
      where: { externalSignatureId: data.externalSignerId },
      defaults: { externalSignatureId: data.externalSignerId, providerEnvelopeId: envelope.externalEnvelopeId, groupId: alvo.groupId, companyId: alvo.companyId }, transaction,
    });
  }
  const params = await readSignatureParams(ctx, transaction);
  const { evidence, complete } = buildEvidence({ envelope, event: ev, row, params });
  const arquivo = await storeEvidenceFile({ groupId: alvo.groupId, companyId: alvo.companyId, name: alvo.id, content: evidence }, transaction);
  await alvo.update({ evidenceJson: evidence, evidenceComplete: complete, evidenceFileId: arquivo.id }, { transaction });
  // Carregado aqui (e não no topo) porque o serviço de assinaturas também importa este módulo.
  const signaturesService = require('../signature.service');
  await signaturesService.handleSignatureWebhook(alvo.externalSignatureId, { signedAt: evidence.signedAtProvider || new Date(), contentHash: envelope.documentSha256, providerEvent: true }, transaction);
  return { applied: true };
}

async function onEnvelopeCompleted(ctx, row, ev, envelope, transaction) {
  const priv = ev.private || {};
  if (envelope.status === 'SIGNED') return { applied: false };
  if (envelope.status !== 'PENDING') {
    await audit(ctx, 'legal.signature.event_ignored', 'SignatureEnvelope', envelope.id, `Conclusão ignorada: o envelope está ${envelope.status} e não reabre.`, null, transaction);
    return { applied: false };
  }
  if (priv.originalSha256 && priv.originalSha256 !== envelope.documentSha256) {
    await markHashMismatch(ctx, row, envelope, priv.originalSha256, transaction);
    return { applied: true };
  }
  const documento = await downloadSigned(ctx, envelope, transaction);
  if (!documento) throw new Error('O fornecedor ainda não devolveu o arquivo assinado do envelope.');
  const { file, sha256 } = await storeSignedFile({ groupId: envelope.groupId, companyId: envelope.companyId, fileName: documento.fileName || `contrato-assinado-${envelope.id}.pdf`, buffer: documento.buffer }, transaction);
  const versao = await ContractVersion.findByPk(envelope.contractVersionId, { transaction });
  if (!versao.signedDocumentFileId) await versao.update({ signedDocumentFileId: file.id }, { transaction });
  await envelope.update({ status: 'SIGNED', signedSha256: sha256, originalConfirmedSha256: priv.originalSha256 || null, signedDocumentFileId: file.id }, { transaction });
  await audit(ctx, 'legal.signature.envelope_signed', 'SignatureEnvelope', envelope.id, 'Envelope concluído: arquivo assinado recebido e hash registrado.', { signedSha256: sha256, originalConfirmedSha256: priv.originalSha256 || null }, transaction);
  await tryCompleteContract(envelope.contractVersionId, transaction);
  return { applied: true };
}

async function onEnvelopeCancelled(ctx, row, ev, envelope, transaction) {
  if (envelope.status === 'SIGNED' || envelope.status === 'HASH_MISMATCH') {
    await audit(ctx, 'legal.signature.event_ignored', 'SignatureEnvelope', envelope.id, `Cancelamento ignorado: o envelope está ${envelope.status} e não reabre nem volta atrás.`, null, transaction);
    return { applied: false };
  }
  if (envelope.status === 'CANCELLED') return { applied: false };
  await envelope.update({ status: 'CANCELLED' }, { transaction });
  const pendentes = await Signature.findAll({ where: { envelopeId: envelope.id, status: 'PENDING' }, transaction });
  for (const s of pendentes) {
    await s.update({ status: 'CANCELLED' }, { transaction });
  }
  await audit(ctx, 'legal.signature.envelope_cancelled', 'SignatureEnvelope', envelope.id, 'Envelope cancelado pelo fornecedor.', null, transaction);
  return { applied: true };
}

const BY_KIND = Object.freeze({ SIGNER_SIGNED: onSignerSigned, ENVELOPE_COMPLETED: onEnvelopeCompleted, ENVELOPE_CANCELLED: onEnvelopeCancelled });

/** Tratador do domínio SIGNATURE do worker da caixa de entrada (M9-D212 + M9-D236): aplica o evento normalizado do fornecedor ao envelope e às assinaturas do Jurídico. */
async function applySignatureEvent(ctx, row, ev, transaction) {
  const tratador = ev.data && BY_KIND[ev.data.kind];
  if (!tratador) return { applied: false };
  const envelope = await findEnvelope(ctx, row, ev.data, transaction);
  if (!envelope) {
    await refuse(ctx, row, { code: 'INTEGRATION_LEGAL_ENVELOPE_UNKNOWN', message: 'Evento de assinatura de um envelope que o sistema não conhece.', severity: 'MEDIUM' }, transaction);
    return { applied: false };
  }
  return tratador(ctx, row, ev, envelope, transaction);
}

let installed = false;
function installSignatureEvents() {
  if (installed) return;
  installed = true;
  registerDomainHandler('SIGNATURE', applySignatureEvent);
}

module.exports = { applySignatureEvent, installSignatureEvents, findEnvelope };
