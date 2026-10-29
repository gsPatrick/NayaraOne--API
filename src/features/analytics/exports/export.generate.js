'use strict';

/**
 * M9-D701 (3.3) — geração do arquivo de UM job RUNNING, numa transação da empresa: reaplica a permissão do solicitante, lê as linhas congeladas pelos
 * filtros do pedido, passa tudo por `prepareSecureRows` (permissão, RESTRICTED mascarado SEMPRE e linha EXPORT_GENERATE no log de acesso), monta o CSV,
 * grava no armazenamento de arquivos (antivírus do projeto), calcula o SHA-256 e só então marca READY com linhas, hash e validade. Qualquer erro desfaz a
 * transação inteira (o job nunca fica READY sem hash); o chamador descarta o arquivo já gravado em disco e marca FAILED.
 */
const clock = require('../metrics/clock');
const { P, prepareSecureRows } = require('../security');
const { updateExportJobState } = require('../exportJobStore.service');
const { uploadFile } = require('../../../engines/biExport/exportFileStorage');
const { assertExportAccess } = require('./export.access');
const { collectExportRows } = require('./export.rows');
const { buildCsv } = require('./export.csv');
const { loadRequesterContext } = require('./export.requester');
const { readExportParams } = require('./export.settings');
const events = require('./export.events');

const planOf = (job) => ({
  kind: job.scope.kind, code: job.scope.code, level: job.scope.level, companyId: job.scope.companyId, groupId: job.scope.groupId,
  asOfDate: job.scope.asOfDate, drilldown: job.scope.drilldown, filters: job.filters || {},
});

/** Nomes dos campos cujo valor mudou ao mascarar (a lista vai para `masked_fields`). */
function maskedNames(before, after) {
  const names = new Set();
  before.forEach((row, i) => { for (const key of Object.keys(row)) if (JSON.stringify(row[key]) !== JSON.stringify(after[i][key])) names.add(key); });
  return [...names].sort();
}

const fileNameOf = (job, plan) => `exportacao-${plan.code.replace(/[^a-z0-9._-]/gi, '_')}-${plan.asOfDate}-${job.id.slice(0, 8)}.csv`;

/** Devolve a linha do job já READY; `track.storageKey` recebe o arquivo gravado em disco; `hooks.afterUpload` (teste) roda depois do arquivo gravado e antes de marcar READY. */
async function generateInTransaction(job, { hooks = {}, now = clock.now(), track = {} } = {}, transaction) {
  const plan = planOf(job);
  const ctx = await loadRequesterContext(job, transaction);
  const access = await assertExportAccess(ctx, plan, transaction); // permissão reaplicada com as permissões de agora
  const params = await readExportParams(ctx, transaction);
  const collected = await collectExportRows(ctx, plan, access, transaction, { maxRows: params.maxRows });
  const secure = await prepareSecureRows(ctx, {
    permission: P.EXPORT, domain: access.domain, action: 'EXPORT_GENERATE', resourceType: 'EXPORT', resourceCode: job.id, route: 'job analyticsExportWorkerJob',
    filters: { target: `${plan.kind}:${plan.code}`, asOfDate: plan.asOfDate, level: plan.level, ...plan.filters }, rows: collected.rows, transaction,
  });
  const csv = buildCsv({ header: collected.header, columns: collected.columns, rows: secure.rows });
  const fileName = fileNameOf(job, plan);
  const file = await uploadFile({ groupId: job.groupId, companyId: job.companyId, fileName, mimeType: 'text/csv', contentBase64: csv.buffer.toString('base64'), category: 'analytics-exports' }, job.requestedBy, transaction);
  track.storageKey = file.storageKey; // se algo falhar daqui em diante, o chamador apaga o arquivo do disco
  if (hooks.afterUpload) await hooks.afterUpload({ job, file });
  const ready = await updateExportJobState(job.id, {
    status: 'READY', rowCount: csv.rowCount, fileId: file.id, fileSha256: csv.sha256, expiresAt: new Date(now.getTime() + params.validityHours * 3600000),
    maskedFields: maskedNames(collected.rows, secure.rows),
  }, transaction);
  const done = { id: job.id, groupId: job.groupId, companyId: job.companyId, requestedBy: job.requestedBy, rowCount: ready.row_count, expiresAt: ready.expires_at };
  await events.audit('finish', done, { actorUserId: job.requestedBy, after: { rowCount: ready.row_count, fileSha256: ready.file_sha256, expiresAt: ready.expires_at, maskedFields: ready.masked_fields }, reason: `Exportação ${plan.kind} ${plan.code} gerada (${ready.row_count} linhas)` }, transaction);
  await events.publish('ready', done, { rowCount: ready.row_count, fileSha256: ready.file_sha256, expiresAt: ready.expires_at }, transaction);
  await events.notifyReady(done, fileName, transaction);
  return ready;
}

module.exports = { generateInTransaction, planOf };
