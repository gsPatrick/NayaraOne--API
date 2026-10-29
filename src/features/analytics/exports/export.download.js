'use strict';

/**
 * M9-D701 (3.4) — download da exportação. `issueDownload` (GET /analytics/exports/:id/download): só o MESMO usuário que pediu (outro, ainda que com
 * `analytics:export`, é 403 PERMISSION_DENIED: o MFA do alto risco é do solicitante); job de outra empresa é 404; FAILED responde 200 com o código e a
 * mensagem; ainda não pronto é 409; vencido (ou EXPIRED) é 410 ANALYTICS_EXPORT_EXPIRED. Pronto: emite o endereço assinado curto, conta +1 download, grava
 * EXPORT_DOWNLOAD no log de acesso (por `prepareSecureRows`), audita e publica `analytics.export.downloaded`. Roda em transação PRÓPRIA com escrita
 * (o GET corre em transação somente leitura). `serveFile` (GET .../file) confere a assinatura e entrega o CSV sem cache.
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const clock = require('../metrics/clock');
const { P, assertPermission, prepareSecureRows } = require('../security');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { findExportJob, incrementDownloadCount } = require('../exportJobQueries.service');
const { getFileContent } = require('../../../engines/biExport/exportFileStorage');
const { signDownloadUrl, verifyDownloadUrl } = require('./export.url');
const { readExportParams } = require('./export.settings');
const { notFound, expired, notReady, REVOKED_CODE, REVOKED_MESSAGE } = require('./export.errors');
const events = require('./export.events');

async function inUserTx(ctx, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query(
      "SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
      { replacements: { g: ctx.groupId, c: ctx.companyId, u: ctx.actorUserId || '' }, transaction }
    );
    await enableAnalyticsWriter(transaction);
    return fn(transaction);
  });
}

async function loadOwnJob(ctx, jobId, transaction) {
  assertPermission(ctx, P.EXPORT);
  const job = /^[0-9a-f-]{36}$/i.test(String(jobId)) ? await findExportJob(jobId, transaction) : null;
  if (!job) throw notFound();
  if (job.requestedBy !== ctx.actorUserId) throw AppError.forbidden('Só quem pediu a exportação pode baixar o arquivo.', 'PERMISSION_DENIED', { permission: 'analytics:export' });
  return job;
}

const isExpired = (job, now) => job.status === 'EXPIRED' || (job.expiresAt && new Date(job.expiresAt).getTime() <= now.getTime());

async function issueDownload(ctx, jobId, { ip = null, route = null, now = clock.now() } = {}) {
  return inUserTx(ctx, async (transaction) => {
    const job = await loadOwnJob(ctx, jobId, transaction);
    if (job.status === 'FAILED') {
      const revoked = job.errorCode === REVOKED_CODE;
      return { jobId: job.id, status: 'FAILED', code: job.errorCode, message: revoked ? REVOKED_MESSAGE : `A exportação falhou (${job.errorCode}).` };
    }
    if (job.status === 'QUEUED' || job.status === 'RUNNING') throw notReady(job.status);
    if (isExpired(job, now)) throw expired();
    const params = await readExportParams(ctx, transaction);
    const link = signDownloadUrl({ jobId: job.id, userId: ctx.actorUserId, now, urlMinutes: params.urlMinutes, fileExpiresAt: job.expiresAt });
    const downloadCount = await incrementDownloadCount(job.id, transaction);
    await prepareSecureRows(ctx, {
      permission: P.EXPORT, domain: job.scope.domain, action: 'EXPORT_DOWNLOAD', resourceType: 'EXPORT', resourceCode: job.id, route,
      filters: { target: `${job.scope.kind}:${job.scope.code}`, fileSha256: job.fileSha256, downloadCount }, rows: [], rowsReturned: job.rowCount, ip, transaction,
    });
    await events.audit('download', job, { actorUserId: ctx.actorUserId, ip, after: { downloadCount, rowCount: job.rowCount, fileSha256: job.fileSha256, linkExpiresAt: link.expiresAt }, reason: 'Endereço de download emitido' }, transaction);
    await events.publish('downloaded', job, { downloadCount, rowCount: job.rowCount, fileSha256: job.fileSha256 }, transaction, `:${downloadCount}`);
    return {
      jobId: job.id, status: 'READY', url: link.url, urlExpiresAt: link.expiresAt, fileExpiresAt: job.expiresAt, rowCount: job.rowCount, fileSha256: job.fileSha256, downloadCount,
    };
  });
}

/** { buffer, fileName, mimeType }: o CSV, depois de conferir a assinatura, o solicitante, o prazo e o hash. `transaction` é a de leitura da requisição. */
async function serveFile(ctx, jobId, { exp, sig, now = clock.now() }, transaction) {
  const job = await loadOwnJob(ctx, jobId, transaction);
  verifyDownloadUrl({ jobId: job.id, userId: ctx.actorUserId, exp, sig, now });
  if (job.status !== 'READY' || isExpired(job, now)) throw expired();
  const file = await getFileContent(job.fileId, transaction, ctx.actorUserId);
  const content = file.getDataValue('content');
  if (file.checksumSha256 !== job.fileSha256) throw AppError.conflict('O arquivo não confere com o registro da exportação.', 'ANALYTICS_EXPORT_FILE_MISMATCH');
  return { buffer: content, fileName: file.fileName, mimeType: 'text/csv; charset=utf-8' };
}

module.exports = { issueDownload, serveFile };
