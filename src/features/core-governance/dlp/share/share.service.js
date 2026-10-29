'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { hasRecentMfa } = require('../../../users/mfa.service');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const guardService = require('../guard.service');
const { blockedError } = require('../guard.reasons');
const dlpSettings = require('../dlp.settings');
const { ADMIN_PERMISSION } = require('../dlp.constants');
const { idempotencyConflict } = require('../dlp.errors');
const { scopedKey } = require('../idempotency.header');
const { sameJson } = require('../canonical');
const { withOwnTenantTransaction } = require('../guard.tx');
const settings = require('./share.settings');
const errors = require('./share.errors');
const repo = require('./share.repository');
const { newToken, hashToken } = require('./share.token');
const { parseShareBody, fingerprint } = require('./share.input');
const { shareView } = require('./share.view');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const justificationMin = async (tenant, transaction) => dlpSettings.parseJustificationMin(
  await getSetting(dlpSettings.JUSTIFICATION_MIN_KEY, tenant, transaction, dlpSettings.DLP_SETTING_DEFAULTS[dlpSettings.JUSTIFICATION_MIN_KEY])
);

/** Registra no pedido (em transação própria, que a recusa não desfaz) o que foi pedido e, se for o caso, o fim dele (bloqueado ou prazo acima do teto). */
const recordJob = (tenant, actorUserId, jobId, data) => withOwnTenantTransaction(tenant, actorUserId, (tx) => repo.attachJob(tenant.companyId, jobId, data, tx));

/** Mesma chave já usada: o mesmo pedido devolve o mesmo link (sem o token, que só se vê uma vez); outro corpo é 409; bloqueado ou recusado repete a recusa. */
async function answerExisting(tenant, actorUserId, job, parsed, transaction) {
  if (job.actorUserId !== actorUserId || (job.request && !sameJson(job.request, fingerprint(parsed)))) throw idempotencyConflict();
  if (job.status === 'BLOCKED') throw blockedError({ blockReason: job.blockReason, job: { id: job.id } }, await justificationMin(tenant, transaction));
  if (job.errorCode === 'GOV_LINK_EXPIRY_TOO_LONG') throw errors.expiryTooLong(job.obligations && job.obligations.maxExpiryHours);
  const link = await repo.findByJob(tenant.companyId, job.id, transaction);
  if (!link) throw idempotencyConflict();
  return { link: shareView(link), token: null, replayed: true };
}

async function expiryCeiling(decision, tenant, transaction) {
  const policyMax = decision.obligations && decision.obligations.maxExpiryHours;
  if (policyMax) return policyMax;
  return settings.intOr(await getSetting(settings.NO_CEILING_KEY, tenant, transaction, settings.SHARE_SETTING_DEFAULTS[settings.NO_CEILING_KEY]), settings.NO_CEILING_KEY);
}

/**
 * POST /dlp/share-links (M9-D823 §3): confere o recurso, passa pelo guard (ação SHARE: finalidade, justificativa e MFA da política), limita o prazo ao teto da classe
 * (422 GOV_LINK_EXPIRY_TOO_LONG), gera o token (32 bytes, só o hash é guardado) e grava link, pedido e auditoria numa transação. Devolve { link, token, replayed }: o token em claro
 * vai só nesta resposta.
 */
async function createShareLink({ tenant, actorUserId, permissions, body, idempotencyKey, transaction }) {
  const key = scopedKey(actorUserId, idempotencyKey, 's');
  const parsed = parseShareBody(body);
  const existing = await repo.findJobByKey(tenant.companyId, key, transaction);
  if (existing) return answerExisting(tenant, actorUserId, existing, parsed, transaction);

  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: actorUserId, permissions };
  const file = await parsed.resource.assertShareable(ctx, parsed.resourceId, transaction);
  const decision = await guardService.decide(tenant, {
    action: 'SHARE', kind: 'SHARE', resourceType: parsed.resource.code, resourceIds: [parsed.resourceId], purpose: parsed.purpose, justification: parsed.justification,
    mfaOk: await hasRecentMfa(actorUserId, transaction), originPermission: parsed.resource.permission, idempotencyKey: key, actorUserId, permissions,
  });
  if (decision.replayed) return answerExisting(tenant, actorUserId, await repo.findJobByKey(tenant.companyId, key, transaction), parsed, transaction);
  const request = fingerprint(parsed);
  if (decision.decision === 'DENY') {
    await recordJob(tenant, actorUserId, decision.job.id, { request });
    throw blockedError(decision, decision.justificationMin);
  }
  const ceiling = await expiryCeiling(decision, tenant, transaction);
  const hours = parsed.expiresInHours || ceiling;
  const wantsMark = decision.obligations.watermark === true;
  try {
    if (hours > ceiling) throw errors.expiryTooLong(ceiling);
    if (wantsMark && parsed.resource.assertWatermarkable) parsed.resource.assertWatermarkable(file);
  } catch (error) {
    await recordJob(tenant, actorUserId, decision.job.id, { request, status: 'FAILED', errorCode: error.code });
    throw error;
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  const link = await repo.insertLink({
    groupId: tenant.groupId, companyId: tenant.companyId, createdBy: actorUserId, resourceType: parsed.resource.code, resourceId: parsed.resourceId, recipientLabel: parsed.recipientLabel,
    classification: decision.classification, tokenHash: hashToken(token), expiresAt, exportJobId: decision.job.id, watermark: wantsMark,
  }, transaction);
  await repo.attachJob(tenant.companyId, decision.job.id, { request, expiresAt }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'dlp.share.created', entityType: 'ShareLink', entityId: link.id, beforeJson: null,
    afterJson: { resourceType: link.resourceType, resourceId: link.resourceId, recipientLabel: link.recipientLabel, classification: link.classification, expiresAt: link.expiresAt, exportJobId: link.exportJobId },
    reason: `Link externo de ${link.resourceType} criado para "${link.recipientLabel}" (vale até ${link.expiresAt.toISOString()}).`,
  }, transaction);
  return { link: shareView(link), token, replayed: false };
}

/** POST /dlp/share-links/:id/revoke: quem criou ou governance:dlp:admin; efeito no acesso seguinte. Link já encerrado (inclusive vencido) é 409. */
async function revokeShareLink({ tenant, actorUserId, permissions, id, transaction }) {
  const link = UUID.test(String(id)) ? await repo.findById(tenant.companyId, id, transaction, { lock: true }) : null;
  if (!link) throw errors.notFound();
  if (link.createdBy !== actorUserId && !(permissions || []).includes(ADMIN_PERMISSION)) throw errors.notOwner();
  if (link.status !== 'ACTIVE' || new Date(link.expiresAt) <= new Date()) throw errors.alreadyFinal();
  const revoked = await repo.markRevoked(tenant.companyId, id, actorUserId, transaction);
  if (!revoked) throw errors.alreadyFinal();
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'dlp.share.revoked', entityType: 'ShareLink', entityId: id, beforeJson: { status: 'ACTIVE' },
    afterJson: { status: 'REVOKED', exportJobId: revoked.exportJobId }, reason: `Link externo de ${revoked.resourceType} revogado.`,
  }, transaction);
  return shareView(revoked);
}

/** GET /dlp/share-links: os links de quem pede; governance:dlp:admin vê os da empresa toda. */
async function listShareLinks({ tenant, actorUserId, permissions, transaction }) {
  const admin = (permissions || []).includes(ADMIN_PERMISSION);
  return (await repo.listLinks(tenant.companyId, admin ? null : actorUserId, transaction)).map((link) => shareView(link));
}

module.exports = { createShareLink, revokeShareLink, listShareLinks };
