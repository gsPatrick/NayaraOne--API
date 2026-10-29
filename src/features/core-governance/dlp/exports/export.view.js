'use strict';

const { signDownloadUrl } = require('./export.url');

/** O pedido de arquivo como a API o mostra; com o arquivo pronto (READY), um endereço de download assinado de uso curto. Nunca expõe o caminho do arquivo. */
function exportView(job, { userId, now, urlMinutes } = {}) {
  const view = {
    exportJobId: job.id, resourceType: job.resourceType, format: job.format, status: job.status, classification: job.classification, purpose: job.purpose,
    filter: job.filter, columns: job.columns, watermark: job.watermark, rowCount: job.rowCount, fileName: job.fileName, fileSha256: job.fileSha256, expiresAt: job.expiresAt,
    requestedAt: job.requestedAt, generatedAt: job.generatedAt, expiredAt: job.expiredAt, errorCode: job.errorCode, downloadCount: job.downloadCount,
  };
  if (job.status === 'READY' && userId && now && new Date(job.expiresAt) > now) view.downloadUrl = signDownloadUrl({ jobId: job.id, userId, now, urlMinutes, fileExpiresAt: job.expiresAt }).url;
  return view;
}

module.exports = { exportView };
