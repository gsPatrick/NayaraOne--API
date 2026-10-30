'use strict';

const { Signature, SignatureEnvelope, IntegrationDispatch } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { transitionDispatch } = require('../../integrations/dispatch/dispatch.transition');
const { compensateDispatch } = require('../../integrations/domain');

const QUEUED = ['PENDING', 'RETRY_WAIT'];

/**
 * Evidência da assinatura presencial/manual (M9-D227 3.3 b): o jurídico baixa o PDF da versão (o rodapé traz o hash), coleta as assinaturas e anexa o arquivo assinado.
 * `evidence_type = MANUAL_UPLOAD`. A evidência guarda o hash do arquivo anexado, o hash do documento da versão (`contract_version.content_hash`, que NÃO muda) e quem coletou.
 * Completa quando o arquivo tem hash e a versão tem hash; sem isso o contrato não vai a SIGNED (portão em signature.complete.js).
 */
function buildManualEvidence({ contractVersion, file, collectedByUserId, signedAt }) {
  const evidence = {
    evidenceType: 'MANUAL_UPLOAD', evidenceFileId: file.id, evidenceFileSha256: file.checksumSha256 || null, documentSha256: contractVersion.contentHash || null,
    collectedByUserId, signedAt: new Date(signedAt || Date.now()).toISOString(), receivedAt: new Date().toISOString(),
  };
  return { evidence, complete: Boolean(evidence.evidenceFileSha256 && evidence.documentSha256) };
}

/**
 * A assinatura manual de uma pessoa substitui o pedido eletrônico PENDENTE dela na mesma versão (M9-D227 3.3 b: fornecedor fora, fluxo alternativo homologado): o pedido
 * eletrônico vira CANCELLED e, se o envelope ficou sem ninguém pendente, ele também é cancelado (o envio ainda na fila é cancelado; o que o fornecedor já aceitou é desfeito por
 * compensação, M9-D220). Quem já assinou eletronicamente não é tocado. Devolve a quantidade de pedidos eletrônicos substituídos.
 */
async function supersedeElectronicRequest(ctx, { contractVersionId, personId, manualSignatureId, actorUserId }, transaction) {
  const pendentes = await Signature.findAll({ where: { contractVersionId, personId, status: 'PENDING', signatureMethod: 'ELECTRONIC' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const s of pendentes) {
    await s.update({ status: 'CANCELLED' }, { transaction });
    await registrarAuditoria({
      groupId: s.groupId, companyId: s.companyId, actorUserId, action: 'legal.signature.superseded_by_manual', entityType: 'Signature', entityId: s.id,
      beforeJson: { status: 'PENDING' }, afterJson: { status: 'CANCELLED', manualSignatureId }, reason: 'O pedido de assinatura eletrônica foi substituído pela assinatura manual com evidência.',
    }, transaction);
  }
  const envelopes = new Set(pendentes.map((s) => s.envelopeId).filter(Boolean));
  for (const id of envelopes) {
    const restantes = await Signature.count({ where: { envelopeId: id, status: 'PENDING' }, transaction });
    const envelope = restantes === 0 ? await SignatureEnvelope.findOne({ where: { id, status: 'PENDING' }, transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (!envelope) continue;
    await envelope.update({ status: 'CANCELLED' }, { transaction });
    const envio = envelope.dispatchId ? await IntegrationDispatch.findOne({ where: { id: envelope.dispatchId, companyId: ctx.companyId }, transaction }) : null;
    if (envio && QUEUED.includes(envio.status)) await transitionDispatch(ctx, envio.id, 'CANCELLED', {}, { motivo: 'Todos os signatários assinaram de forma manual: o envelope eletrônico não é mais necessário.' }, transaction);
    else if (envio && ['SUBMITTED', 'CONFIRMED'].includes(envio.status) && envio.externalResourceId) await compensateDispatch(ctx, envio.id, { userId: actorUserId || null, transaction });
  }
  return pendentes.length;
}

module.exports = { buildManualEvidence, supersedeElectronicRequest };
