'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { assertCanReadFile } = require('../../../files/fileAccess.service');
const { mktError, mktForbidden } = require('../../marketing.errors');
const repo = require('./media.repository');
const { fileInfo } = require('./media.files');
const { readVideoConfig } = require('./video.settings');
const { mediaNotAuthorized, mediaNotFound, videoInvalid } = require('./video.errors');

const ENTITY = 'MarketingMediaAuthorization';
const MEDIA_MIME = /^(image|video)\//;
const view = (row) => ({ fileId: row.file_id, sha256: row.sha256, origin: row.origin, authorizedBy: row.authorized_by, authorizedAt: row.authorized_at, revokedAt: row.revoked_at || null });

/** Acesso ao arquivo pelo módulo de arquivos, com os erros no padrão do Marketing (MKT_NOT_FOUND, MKT_FORBIDDEN). */
async function readableFile(fileId, auth, transaction) {
  try {
    return await assertCanReadFile(fileId, auth, transaction);
  } catch (err) {
    if (err.code === 'FILE_NOT_FOUND') throw mediaNotFound();
    if (err.code === 'FILE_ACCESS_FORBIDDEN') throw mktForbidden({ reason: 'FILE_ACCESS' });
    throw err;
  }
}

/**
 * POST /marketing/media/:id/authorize (rota I9, M9-D426 regra 1): quem tem acesso ao arquivo pelo módulo de arquivos o autoriza para marketing, com a origem (lista do
 * parâmetro). Só imagem ou vídeo, já examinado pelo antivírus (CLEAN) e com SHA-256 gravado. Reautorizar arquivo revogado reabre a autorização. `auth` = req.auth.
 */
async function authorizeMedia({ tenant, auth, fileId, origin }, transaction) {
  const { file } = await readableFile(fileId, auth, transaction);
  if (!MEDIA_MIME.test(String(file.mimeType || ''))) throw videoInvalid('Só imagem ou vídeo pode ser autorizado para marketing.', { mimeType: file.mimeType });
  if (file.scanStatus !== 'CLEAN') throw mediaNotAuthorized({ reason: 'SCAN_NOT_CLEAN', fileId });
  if (!file.checksumSha256) throw mediaNotAuthorized({ reason: 'NO_HASH', fileId });
  const config = await readVideoConfig(tenant, transaction);
  const chosen = String(origin || '').trim().toUpperCase();
  if (!config.origins.includes(chosen)) throw mktError(422, 'MKT_VALIDATION', 'Origem da mídia inválida.', { field: 'origin', validos: config.origins });
  const before = await repo.lockAuthorization(fileId, transaction);
  const row = await repo.upsertAuthorization(tenant, { fileId, sha256: file.checksumSha256, origin: chosen, actor: auth.userId }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: auth.userId, action: 'marketing.media.authorize', entityType: ENTITY, entityId: row.id,
    beforeJson: before ? view(before) : null, afterJson: view(row), reason: 'Mídia autorizada para uso em marketing.',
  }, transaction);
  return view(row);
}

/** Revoga a autorização (serviço, sem rota: o livro não cria rota além das listadas). Conteúdo novo e agendamento deixam de aceitar a mídia. */
async function revokeMedia({ tenant, actor, fileId }, transaction) {
  const before = await repo.lockAuthorization(fileId, transaction);
  if (!before || before.revoked_at) throw mediaNotFound();
  const row = await repo.markRevoked(fileId, actor, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.media.revoke', entityType: ENTITY, entityId: row.id,
    beforeJson: view(before), afterJson: view(row), reason: 'Autorização de mídia revogada.',
  }, transaction);
  return view(row);
}

/** O arquivo está autorizado agora? Revogada, ausente ou com o SHA-256 diferente do autorizado: 422 MKT_MEDIA_NOT_AUTHORIZED. Devolve { authorization, file }. */
async function assertAuthorized(fileId, transaction) {
  const authorization = await repo.findAuthorization(fileId, transaction);
  if (!authorization) throw mediaNotAuthorized({ reason: 'NOT_AUTHORIZED', fileId });
  if (authorization.revoked_at) throw mediaNotAuthorized({ reason: 'REVOKED', fileId });
  const file = await fileInfo(fileId, transaction);
  if (!file || file.checksum_sha256 !== authorization.sha256 || file.scan_status !== 'CLEAN') throw mediaNotAuthorized({ reason: 'FILE_CHANGED', fileId });
  return { authorization, file };
}

module.exports = { authorizeMedia, revokeMedia, assertAuthorized };
