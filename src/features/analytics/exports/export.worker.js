'use strict';

/**
 * M9-D701 (3.3 e 6) — worker da exportação de UMA empresa. Estados: QUEUED -> RUNNING -> READY ou FAILED.
 *  - pega o próximo job com `FOR UPDATE SKIP LOCKED` numa transação curta que já o marca RUNNING e audita o início: dois workers nunca executam o mesmo job;
 *  - gera o arquivo em outra transação (export.generate). Se der erro: a transação desfaz tudo (o job nunca fica READY sem hash), o arquivo já gravado em
 *    disco é apagado e o job vira FAILED com o código do erro (permissão revogada, indicador degradado, arquivo grande demais...), com auditoria e aviso.
 */
const logger = require('../../../utils/logger');
const diskStorage = require('../../../utils/diskStorage');
const { inCompany } = require('../companyTx');
const { claimNextQueuedJob } = require('../exportJobQueries.service');
const { updateExportJobState } = require('../exportJobStore.service');
const { generateInTransaction } = require('./export.generate');
const { failureCodeOf } = require('./export.requester');
const { REVOKED_CODE, REVOKED_MESSAGE } = require('./export.errors');
const events = require('./export.events');
const { Notification } = require('../../../models');

async function claim(scope) {
  return inCompany(scope, async (transaction) => {
    const job = await claimNextQueuedJob(transaction);
    if (job) await events.audit('start', job, { actorUserId: job.requestedBy, before: { status: 'QUEUED' }, after: { status: 'RUNNING' }, reason: 'Geração da exportação iniciada' }, transaction);
    return job;
  });
}

async function markFailed(scope, job, code, message) {
  await inCompany(scope, async (transaction) => {
    await updateExportJobState(job.id, { status: 'FAILED', errorCode: code }, transaction);
    await events.audit('fail', job, { actorUserId: job.requestedBy, before: { status: 'RUNNING' }, after: { status: 'FAILED', errorCode: code }, reason: `Exportação falhou: ${code}` }, transaction);
    await Notification.create({
      groupId: job.groupId, companyId: job.companyId, userId: job.requestedBy, channel: 'IN_APP', title: 'Sua exportação não foi gerada',
      body: code === REVOKED_CODE ? REVOKED_MESSAGE : `A exportação falhou (${code}). ${message || ''}`.trim(),
    }, { transaction });
  });
}

async function runOne(scope, job, options) {
  const track = {};
  try {
    const ready = await inCompany(scope, (transaction) => generateInTransaction(job, { ...options, track }, transaction));
    return { jobId: job.id, status: 'READY', rowCount: ready.row_count };
  } catch (err) {
    if (track.storageKey) {
      try { diskStorage.deleteFile(track.storageKey); } catch (cleanupErr) { logger.error({ err: cleanupErr, jobId: job.id }, '[analytics.export] não foi possível apagar o arquivo incompleto'); }
    }
    const code = failureCodeOf(err);
    if (code === 'ANALYTICS_EXPORT_FAILED') logger.error({ err, jobId: job.id }, '[analytics.export] a geração falhou');
    await markFailed(scope, job, code, err && err.message);
    return { jobId: job.id, status: 'FAILED', errorCode: code };
  }
}

/** Processa a fila da empresa até esvaziar (ou `limit`). Devolve [{ jobId, status, rowCount | errorCode }]. options: { hooks, now }. */
async function runExportWorker(scope, { limit = 50, ...options } = {}) {
  const results = [];
  for (let i = 0; i < limit; i += 1) {
    const job = await claim(scope);
    if (!job) break;
    results.push(await runOne(scope, job, options));
  }
  return results;
}

module.exports = { runExportWorker };
