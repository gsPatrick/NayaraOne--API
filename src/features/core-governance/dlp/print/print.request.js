'use strict';

const { hasRecentMfa } = require('../../../users/mfa.service');
const guardService = require('../guard.service');
const { blockedError } = require('../guard.reasons');
const grants = require('../grants/grant.service');
const { parsePrintBody } = require('./print.input');
const { readPrintParams } = require('./print.params');

/**
 * POST /dlp/print-events (M9-D920 §3.1): toda tela ou relatório imprimível passa por aqui ANTES de abrir a visão de impressão. Confere que o registro existe e que quem pede
 * pode vê-lo, passa pelo guard (ação PRINT, kind PRINT: finalidade, justificativa, MFA conforme a classe) e, aprovado, devolve { exportJobId, status, printUrl }, o endereço
 * assinado e de uso único do PDF (válido o MENOR entre `governanca.dlp.impressao.url_min` e o teto da política PRINT da classe, quando existe). Bloqueio sobe o erro do guard
 * (403 ou 422) e o pedido fica BLOCKED. Cada chamada é um pedido novo: reimpressão gera novo evento.
 */
async function requestPrint({ tenant, auth, ip, body, transaction }) {
  const parsed = parsePrintBody(body);
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: auth.userId, permissions: auth.permissions };
  await parsed.resource.assertShareable(ctx, parsed.resourceId, transaction);
  const decision = await guardService.decide(tenant, {
    action: 'PRINT', kind: 'PRINT', resourceType: parsed.resource.code, resourceIds: [parsed.resourceId], purpose: parsed.purpose, justification: parsed.justification,
    mfaOk: await hasRecentMfa(auth.userId, transaction), originPermission: parsed.resource.permission, watermarkRequested: parsed.watermark, permissions: auth.permissions,
    actorUserId: auth.userId, ip,
  });
  if (decision.decision === 'DENY') throw blockedError(decision, decision.justificationMin);
  const params = await readPrintParams(tenant, transaction);
  const grant = await grants.emit({
    tenant, actorUserId: auth.userId, decision, kind: 'PRINT', basePath: `/api/v1/dlp/print-events/${decision.job.id}/pdf`, urlMinutes: params.urlMinutes,
    watermark: decision.obligations.watermark === true, resourceRef: { resourceType: parsed.resource.code, resourceId: parsed.resourceId },
  });
  return { exportJobId: grant.exportJobId, status: grant.status, printUrl: grant.url, expiresAt: grant.expiresAt, classification: grant.classification, watermark: grant.watermark };
}

module.exports = { requestPrint };
