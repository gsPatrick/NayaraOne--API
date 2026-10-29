'use strict';

const crypto = require('node:crypto');
const { File } = require('../../../models');
const diskStorage = require('../../../utils/diskStorage');
const { encryptFileBuffer } = require('../../../utils/fileCrypto');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Evidência de UMA assinatura (M9-D236 3.2 item 4): horário do fornecedor (UTC), IP e user-agent (quando fornecidos), método de autenticação, hash do documento assinado
 * (o que foi enviado e o fornecedor assinou), identificador do evento e do signatário. Completa quando tem horário, método e hash, e IP e user-agent se a empresa os exigir.
 */
function buildEvidence({ envelope, event, row, params }) {
  const p = event.private || {};
  const e = p.evidence || {};
  const evidence = {
    providerCode: row.providerCode, externalEventId: row.externalEventId, externalSignerId: (event.data && event.data.externalSignerId) || null, signerEmail: p.signerEmail || null,
    signedAtProvider: p.signedAt ? new Date(p.signedAt).toISOString() : null, ip: e.ip || null, userAgent: e.userAgent || null, authMethod: e.authMethod || null,
    documentSha256: envelope.documentSha256, receivedAt: new Date().toISOString(),
  };
  if (evidence.signedAtProvider === 'Invalid Date') evidence.signedAtProvider = null;
  const completa = Boolean(evidence.signedAtProvider && evidence.authMethod && evidence.documentSha256) && (!params.exigirIpUserAgent || Boolean(evidence.ip && evidence.userAgent));
  return { evidence, complete: completa };
}

/** Assinatura simulada pelo fluxo interno do sandbox (fora de produção): a evidência diz que é simulada, e só vale para o fornecedor de laboratório. */
function simulatedEvidence(envelope) {
  return { providerCode: envelope.providerCode, simulated: true, signedAtProvider: new Date().toISOString(), authMethod: 'SANDBOX_SIMULATED', documentSha256: envelope.documentSha256, receivedAt: new Date().toISOString() };
}

/** Guarda o arquivo de evidência (trilha do fornecedor, JSON) cifrado em repouso, como os demais arquivos; a linha de `files` leva o hash. Devolve o File. */
async function storeEvidenceFile({ groupId, companyId, name, content }, transaction) {
  const buffer = Buffer.from(JSON.stringify(content, null, 2), 'utf8');
  const fileName = `evidencia-${name}.json`;
  const storageKey = diskStorage.saveFile('contracts-evidence', groupId, fileName, encryptFileBuffer(buffer));
  return File.create({
    groupId, companyId, storageKey, fileName, mimeType: 'application/json', sizeBytes: buffer.length, checksumSha256: sha256(buffer), uploadedByUserId: null, createdBy: null, updatedBy: null,
  }, { transaction });
}

/** Guarda o arquivo assinado devolvido pelo fornecedor (cifrado), com o hash do que foi recebido. */
async function storeSignedFile({ groupId, companyId, fileName, buffer }, transaction) {
  const storageKey = diskStorage.saveFile('contracts-signed', groupId, fileName, encryptFileBuffer(buffer));
  const file = await File.create({
    groupId, companyId, storageKey, fileName, mimeType: 'application/pdf', sizeBytes: buffer.length, checksumSha256: sha256(buffer), uploadedByUserId: null, createdBy: null, updatedBy: null,
  }, { transaction });
  return { file, sha256: sha256(buffer) };
}

module.exports = { buildEvidence, simulatedEvidence, storeEvidenceFile, storeSignedFile, sha256 };
