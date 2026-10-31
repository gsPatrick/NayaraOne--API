'use strict';

const { hasRecentMfa } = require('../../../users/mfa.service');
const guardService = require('../guard.service');
const { blockedError } = require('../guard.reasons');
const grants = require('../grants/grant.service');
const policyService = require('../policy.service');
const { highestClass } = require('../dlp.constants');
const { readDownloadParams } = require('./download.params');
const { effectiveClass, isGuarded } = require('./download.class');
const { assertMarkable } = require('./download.mark');

/**
 * Decisão do download de anexos (M9-D920 §3.3). `items` = [{ file, restricted }] já conferidos quanto ao acesso do módulo dono. Devolve:
 *  - { mode: 'direct', classification, watermark }: LOW ou MEDIUM de um arquivo só; baixa na hora, com auditoria simples (e a marca quando a política da classe a liga ou foi pedida);
 *  - { mode: 'grant', ... }: HIGH, RESTRICTED ou lote (zip, volume = número de arquivos): o guard decidiu, o pedido ficou registrado (kind DOWNLOAD) e há um endereço assinado de uso único.
 * Bloqueio sobe o erro do guard (403 ou 422) com o pedido BLOCKED. Marca ligada ou pedida em tipo que não a aceita: 422 GOV_FILE_WATERMARK_UNSUPPORTED (o pedido termina FAILED).
 */
async function decideDownload({ tenant, auth, ip, items, input, batch = false, transaction }) {
  const params = await readDownloadParams(tenant, transaction);
  const classification = highestClass(items.map((item) => effectiveClass(item.file, item.restricted)));
  const files = items.map((item) => item.file);
  if (!batch && !isGuarded(classification)) {
    const policy = await policyService.getPolicy(tenant, classification, 'EXPORT', transaction);
    const watermark = input.watermark || policy.requireWatermark === true;
    if (watermark) assertMarkable(files);
    return { mode: 'direct', classification, watermark, params };
  }
  const decision = await guardService.decide(tenant, {
    action: 'EXPORT', kind: 'DOWNLOAD', resourceType: 'files.file', resourceIds: files.map((file) => file.id), minClassification: classification, estimatedRows: files.length,
    purpose: input.purpose, justification: input.justification, mfaOk: await hasRecentMfa(auth.userId, transaction), watermarkRequested: input.watermark,
    permissions: auth.permissions, actorUserId: auth.userId, ip,
  });
  if (decision.decision === 'DENY') throw blockedError(decision, decision.justificationMin);
  const watermark = decision.obligations.watermark === true;
  if (watermark) {
    try { assertMarkable(files); } catch (error) { await grants.fail(tenant, auth.userId, decision.job.id, error.code); throw error; }
  }
  return { mode: 'grant', classification: decision.classification, watermark, decision, params, fileIds: files.map((file) => file.id) };
}

/** Emite o endereço assinado de uso único do pedido aprovado (o menor entre `governanca.dlp.download.url_min` e o teto da classe). */
const issueDownloadGrant = (tenant, auth, decided) => grants.emit({
  tenant, actorUserId: auth.userId, decision: decided.decision, kind: 'DOWNLOAD', basePath: `/api/v1/files/downloads/${decided.decision.job.id}`,
  urlMinutes: decided.params.urlMinutes, watermark: decided.watermark, resourceRef: { fileIds: decided.fileIds },
});

module.exports = { decideDownload, issueDownloadGrant };
