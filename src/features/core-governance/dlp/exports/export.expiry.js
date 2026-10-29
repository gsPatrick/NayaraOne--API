'use strict';

const diskStorage = require('../../../../utils/diskStorage');
const logger = require('../../../../utils/logger');
const { File } = require('../../../../models');
const { readExportParams } = require('./export.params');
const repo = require('./export.repository');
const { auditExport } = require('./export.audit');

const BATCH = 100;

/**
 * Passada do exportExpiryJob numa empresa, dentro da transação do job (M9-D822 §3.2 item 2): READY com expires_at vencido vira EXPIRED, o registro e o arquivo físico saem
 * e o hash fica no pedido; GENERATING parado além do limite vira FAILED (GOV_EXPORT_TIMEOUT). O disco só é apagado depois do commit (`afterCommit`), para um
 * erro de gravação não deixar o pedido pronto sem arquivo. Devolve { expired, timedOut, storageKeys }.
 */
async function expireCompany(tenant, transaction, { now = new Date() } = {}) {
  const params = await readExportParams(tenant, transaction);
  const storageKeys = [];
  const due = await repo.listExpired(tenant.companyId, now, BATCH, transaction);
  for (const job of due) {
    const file = job.fileId ? await File.findByPk(job.fileId, { transaction }) : null;
    await repo.markExpired(tenant.companyId, job.id, transaction);
    if (file) { storageKeys.push(file.storageKey); await file.destroy({ force: true, transaction }); }
    await auditExport(job, 'expired', { actorUserId: null, before: { status: 'READY' }, after: { status: 'EXPIRED', fileRemoved: Boolean(file), fileSha256: job.fileSha256 }, reason: 'Arquivo de exportação expirou e foi apagado.' }, transaction);
  }
  const stale = await repo.listStale(tenant.companyId, new Date(now.getTime() - params.generationTimeoutMinutes * 60000), BATCH, transaction);
  for (const job of stale) {
    await repo.markFailed(tenant.companyId, job.id, 'GOV_EXPORT_TIMEOUT', transaction);
    await auditExport(job, 'failed', { actorUserId: null, after: { errorCode: 'GOV_EXPORT_TIMEOUT' }, reason: 'A geração da exportação passou do tempo máximo.' }, transaction);
  }
  return { expired: due.length, timedOut: stale.length, storageKeys };
}

/** Apaga do disco os arquivos já expirados (depois do commit); falha só vai ao log, porque o pedido já está EXPIRED. */
function removeFromDisk(storageKeys) {
  for (const key of storageKeys) {
    try { diskStorage.deleteFile(key); } catch (err) { logger.error({ err: err.message }, 'dlp.export.expiry.disk.failed'); }
  }
}

module.exports = { expireCompany, removeFromDisk };
