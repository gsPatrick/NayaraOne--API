'use strict';

/**
 * Guard de vínculo de arquivo (I1, revisão independente da conferência Nayara 18/10/2026).
 *
 * Toda escrita autenticada que manda IDs de arquivo no corpo (fileId, fileIds, evidenceFileId,
 * evidenceFileIds, documentFileId, photosFileIds, satisfiedByFileId, invoiceFileId,
 * beforeMediaFileIds, settlementEvidenceFileId...) só passa se o ator já puder LER cada um
 * desses arquivos (fileAccess.service#assertCanAttachFiles). É o mesmo ponto para os ~30
 * serviços que recebem arquivo, em vez de uma chamada espalhada em cada um — um serviço novo
 * fica protegido sem precisar lembrar do guard, desde que o campo siga a convenção de nome
 * `*FileId` / `*FileIds` (todos os campos de arquivo da API seguem).
 *
 * Roda dentro do tenantMiddleware (depois do auth): todos os routers autenticados passam por
 * ele. Como cada router monta o tenantMiddleware sem path, ele pode rodar mais de uma vez na
 * mesma requisição — a checagem é feita uma vez só (flag em req).
 */

const fileAccessService = require('../features/files/fileAccess.service');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_KEY_PATTERN = /^(fileIds?|[a-z][a-zA-Z0-9]*FileIds?)$/;
const MAX_DEPTH = 6;

function collectFileIds(value, depth = 0, out = new Set()) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectFileIds(item, depth + 1, out));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FILE_KEY_PATTERN.test(key)) {
      const candidates = Array.isArray(child) ? child : [child];
      candidates.forEach((candidate) => {
        if (typeof candidate === 'string' && UUID_PATTERN.test(candidate)) out.add(candidate);
      });
    } else if (child && typeof child === 'object') {
      collectFileIds(child, depth + 1, out);
    }
  }
  return out;
}

function fileAttachGuard(req, res, next) {
  if (req.fileAttachGuardChecked || !MUTATING_METHODS.has(req.method)) return next();
  req.fileAttachGuardChecked = true;

  const fileIds = [...collectFileIds(req.body)];
  if (fileIds.length === 0) return next();

  return req
    .withTenantTransaction((transaction) => fileAccessService.assertCanAttachFiles(fileIds, req.auth, transaction))
    .then(() => next())
    .catch(next);
}

module.exports = fileAttachGuard;
module.exports.collectFileIds = collectFileIds;
