'use strict';

/**
 * M9-D701 (3.4 e 6) — limpeza de UMA empresa: (1) job READY vencido vira EXPIRED e o arquivo é apagado (registro e disco), com auditoria e o evento
 * `analytics.export.expired`; (2) job que ficou RUNNING além de `analytics.export.timeout_execucao_minutos` (worker que morreu) vira FAILED com
 * ANALYTICS_EXPORT_TIMEOUT. O disco só é apagado depois do commit do estado: se a remoção falhar, o job já está EXPIRED e o erro vai para o log.
 */
const logger = require('../../../utils/logger');
const diskStorage = require('../../../utils/diskStorage');
const { File } = require('../../../models');
const clock = require('../metrics/clock');
const { inCompany } = require('../companyTx');
const { listExpiredReadyJobs, listStaleRunningJobs } = require('../exportJobQueries.service');
const { updateExportJobState } = require('../exportJobStore.service');
const { readExportParams } = require('./export.settings');
const events = require('./export.events');

const BATCH = 100;

async function expireOne(scope, job) {
  const storageKey = await inCompany(scope, async (transaction) => {
    const file = job.fileId ? await File.findByPk(job.fileId, { transaction }) : null;
    await updateExportJobState(job.id, { status: 'EXPIRED' }, transaction);
    if (file) await file.destroy({ force: true, transaction });
    await events.audit('expire', job, { before: { status: 'READY' }, after: { status: 'EXPIRED', fileRemoved: Boolean(file) }, reason: 'Arquivo de exportação expirou e foi apagado' }, transaction);
    await events.publish('expired', job, { rowCount: job.rowCount }, transaction);
    return file ? file.storageKey : null;
  });
  if (storageKey) {
    try { diskStorage.deleteFile(storageKey); } catch (err) { logger.error({ err, jobId: job.id }, '[analytics.export] não foi possível apagar o arquivo expirado do disco'); }
  }
}

async function failStale(scope, job) {
  await inCompany(scope, async (transaction) => {
    await updateExportJobState(job.id, { status: 'FAILED', errorCode: 'ANALYTICS_EXPORT_TIMEOUT' }, transaction);
    await events.audit('fail', job, { before: { status: 'RUNNING' }, after: { status: 'FAILED', errorCode: 'ANALYTICS_EXPORT_TIMEOUT' }, reason: 'Exportação ficou em andamento além do limite' }, transaction);
  });
}

/** Devolve { expired, timedOut }. */
async function runExportCleanup(scope, { now = clock.now() } = {}) {
  const { expiredJobs, staleJobs } = await inCompany(scope, async (transaction) => {
    const params = await readExportParams(scope, transaction);
    return {
      expiredJobs: await listExpiredReadyJobs(now, BATCH, transaction),
      staleJobs: await listStaleRunningJobs(new Date(now.getTime() - params.runTimeoutMinutes * 60000), BATCH, transaction),
    };
  });
  for (const job of expiredJobs) await expireOne(scope, job);
  for (const job of staleJobs) await failStale(scope, job);
  return { expired: expiredJobs.length, timedOut: staleJobs.length };
}

module.exports = { runExportCleanup };
