'use strict';

const { User } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { VIEW_RESTRICTED_PERMISSION } = require('../dlp.constants');
const { fillTemplate } = require('../exports/export.settings');
const { withOwnTenantTransaction } = require('../guard.tx');
const grants = require('../grants/grant.service');
const { govError } = require('../../governance.errors');
const { getPrintable } = require('./print.catalog');
const { maskForPrint } = require('./print.mask');
const { renderPrintPdf } = require('./print.render');
const { readPrintParams } = require('./print.params');
const { fillFooter } = require('./print.settings');

/** "30/10/2026 10:00" no fuso configurado (padrão America/Sao_Paulo). */
function formatStamp(date, timeZone) {
  return date.toLocaleString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
}

/**
 * GET /dlp/print-events/:id/pdf?exp&sig (M9-D920 §3.1): o endereço assinado de uso único. Confere dono, prazo, uso anterior e assinatura; relê o recurso com a permissão de agora, mascara
 * os campos que a pessoa não pode ver, gera o PDF com o rodapé "Impresso por <usuário> em <data/hora> · documento <id>" em toda página e a marca d'água do pedido (quando a política da
 * classe a liga ou foi pedida), usa o endereço e audita `dlp.print` com IP e agente. Falha ao gerar a marca recusa a impressão (o pedido termina FAILED); o PDF nunca sai sem ela.
 */
async function servePrint({ tenant, auth, jobId, exp, sig, ip, userAgent, now = new Date() }) {
  return withOwnTenantTransaction(tenant, auth.userId, async (transaction) => {
    const job = await grants.open({ tenant, actorUserId: auth.userId, jobId, kind: 'PRINT', exp, sig, now }, transaction);
    const ref = job.resourceRef || {};
    const resource = getPrintable(ref.resourceType);
    if (!resource) throw govError(409, 'GOV_PRINT_RESOURCE_INVALID', 'Este tipo de documento não pode ser impresso por aqui.');
    if (resource.permission && !(auth.permissions || []).includes(resource.permission)) throw govError(403, 'GOV_DLP_PERMISSION', 'Você não tem permissão para esta exportação.');
    const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: auth.userId, permissions: auth.permissions };
    const loaded = await resource.load(ctx, ref.resourceId, transaction);
    if (!loaded) throw govError(404, 'GOV_NOT_FOUND', 'Registro não encontrado.');
    const params = await readPrintParams(tenant, transaction);
    const user = await User.findByPk(auth.userId, { transaction });
    const who = (user && (user.name || user.email)) || auth.userId;
    const when = formatStamp(now, params.timeZone);
    const footer = fillFooter(params.footer, { usuario: who, data: when, documento: ref.resourceId });
    const watermarkText = job.watermark ? fillTemplate(params.watermarkText, { usuario: who, data: when, job: job.id }) : null;
    const data = maskForPrint(loaded.data, resource.fields, { canViewRestricted: (auth.permissions || []).includes(VIEW_RESTRICTED_PERMISSION), maskText: params.maskText });
    let buffer;
    try {
      buffer = await renderPrintPdf({ title: resource.label, data, footer, watermarkText });
    } catch (error) {
      await grants.fail(tenant, auth.userId, job.id, 'GOV_PRINT_RENDER_FAILED');
      throw govError(500, 'GOV_PRINT_RENDER_FAILED', 'Não foi possível gerar o PDF de impressão.');
    }
    await grants.consume(tenant, job.id, transaction);
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: auth.userId, action: 'dlp.print', entityType: 'ExportJob', entityId: job.id, beforeJson: null,
      afterJson: { exportJobId: job.id, resourceType: resource.code, resourceId: ref.resourceId, classification: job.classification, watermark: Boolean(job.watermark), ...(ip ? { ip } : {}), ...(userAgent ? { userAgent: String(userAgent).slice(0, 300) } : {}) },
      reason: `${resource.label} impresso (classe ${job.classification}${job.watermark ? ', com marca d\'água' : ''}).`,
    }, transaction);
    return { buffer, fileName: `${resource.code.replace(/[^a-z0-9._-]/gi, '_')}-${ref.resourceId.slice(0, 8)}.pdf`, watermark: Boolean(job.watermark) };
  });
}

module.exports = { servePrint, formatStamp };
