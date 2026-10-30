'use strict';

const crypto = require('node:crypto');
const { detectType, sameType, normalizeMime, EXECUTABLES } = require('./quarantine.magic');
const { inspectZip, isZip } = require('./quarantine.zip');
const { activeContent } = require('./quarantine.active');
const { stripMetadata } = require('./quarantine.strip');
const { findDocumentNumbers, containsEmail, containsSecretLike } = require('../../../shared/redaction');
const { STATUS } = require('./quarantine.constants');

const rejeita = (status, reason, extra = {}) => ({ status, reason, ...extra });

/** O texto do arquivo (amostra) parece ter dado pessoal ou segredo? Só marca; o arquivo promovido já nasce CONFIDENTIAL. */
function looksPersonal(buffer) {
  const amostra = buffer.toString('latin1', 0, Math.min(buffer.length, 1048576));
  const docs = findDocumentNumbers(amostra);
  return Boolean(docs && (docs.cpf || docs.cnpj)) || containsEmail(amostra) || containsSecretLike(amostra);
}

/**
 * As verificações de conteúdo da quarentena (M9-D247 3.1 item 2, tudo menos o antivírus): tamanho (c), tipo real contra o declarado e a lista (b), arquivo compactado (g), conteúdo
 * ativo de PDF e Office (e, f), remoção de metadados de imagem (d) e marca de dado pessoal (h). Devolve { status, reason, detectedMime, buffer (limpo), sha256 (do limpo), stripped, piiDetected }.
 */
function runChecks(buffer, { declaredMime, params }) {
  if (buffer.length > params.maxBytes) return rejeita(STATUS.REJECTED_SIZE, 'SIZE');
  const detectedMime = detectType(buffer);
  const base = { detectedMime, buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  const rej = (status, reason) => ({ ...rejeita(status, reason), ...base, executable: EXECUTABLES.includes(detectedMime) });
  if (isZip(buffer)) {
    const z = inspectZip(buffer, { maxDepth: params.zipMaxDepth, maxRatio: params.zipMaxRatio, limitBytes: params.maxBytes });
    if (!z.ok && z.reason !== 'CORRUPT') return rej(STATUS.REJECTED_BOMB, z.reason);
  }
  if (!params.allowedTypes.includes(detectedMime)) return rej(STATUS.REJECTED_TYPE, 'TYPE_NOT_ALLOWED');
  if (!sameType(declaredMime, detectedMime)) return rej(STATUS.REJECTED_TYPE, 'TYPE_MISMATCH');
  if (!params.allowedTypes.includes(normalizeMime(declaredMime)) && !sameType(declaredMime, detectedMime)) return rej(STATUS.REJECTED_TYPE, 'TYPE_NOT_ALLOWED');
  const ativo = activeContent(buffer, detectedMime);
  if (ativo) return rej(STATUS.REJECTED_TYPE, ativo);
  const limpo = stripMetadata(buffer, detectedMime);
  return {
    status: STATUS.CLEAN, reason: null, detectedMime, buffer: limpo.buffer, sha256: crypto.createHash('sha256').update(limpo.buffer).digest('hex'), stripped: limpo.stripped, piiDetected: looksPersonal(limpo.buffer),
  };
}

module.exports = { runChecks, looksPersonal };
