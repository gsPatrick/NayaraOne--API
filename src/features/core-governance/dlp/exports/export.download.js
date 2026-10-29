'use strict';

const { getFileContent } = require('../../../files/files.service');
const errors = require('./export.errors');
const repo = require('./export.repository');
const { loadJob, assertOwnerOrAdmin } = require('./export.read');
const { verifyDownloadUrl } = require('./export.url');
const { auditExport } = require('./export.audit');
const { inTenant } = require('./export.tx');
const { MIME } = require('./render');

/**
 * GET /exports/:id/download (M9-D822 §3.2 item 3): login, a mesma pessoa que pediu (ou governance:dlp:admin), arquivo pronto e dentro da validade e o endereço
 * assinado. Ordem das recusas: de outra pessoa 403, ainda gerando 409, falhou 409, vencido ou expirado 410, assinatura 403. Cada download conta, é auditado
 * (dlp.export.downloaded com IP e user agent) e devolve o arquivo decifrado e conferido pelo hash do armazenamento.
 */
async function downloadExport({ tenant, actorUserId, permissions, id, exp, sig, ip, userAgent, now = new Date() }) {
  return inTenant(tenant, actorUserId, async (transaction) => {
    const job = await loadJob(tenant, id, transaction);
    assertOwnerOrAdmin(job, actorUserId, permissions);
    if (job.status === 'APPROVED' || job.status === 'GENERATING') throw errors.notReady();
    if (job.status === 'FAILED') throw errors.failed(job.errorCode);
    if (job.status === 'EXPIRED' || (job.expiresAt && new Date(job.expiresAt) <= now)) throw errors.expired();
    if (job.status !== 'READY' || !job.fileId) throw errors.notFound();
    verifyDownloadUrl({ jobId: job.id, userId: job.actorUserId, exp, sig, now });
    const file = await getFileContent(job.fileId, transaction, actorUserId);
    const { downloadCount } = await repo.countDownload(tenant.companyId, job.id, transaction);
    await auditExport(job, 'downloaded', { actorUserId, after: { downloadCount, fileSha256: job.fileSha256, rowCount: job.rowCount }, ip, userAgent, reason: `Arquivo da exportação ${job.resourceType} baixado.` }, transaction);
    const content = file.getDataValue('content');
    return { buffer: content, fileName: job.fileName, mimeType: MIME[job.format] || file.mimeType, sha256: job.fileSha256 };
  });
}

module.exports = { downloadExport };
