'use strict';

const diskStorage = require('../../../../utils/diskStorage');
const logger = require('../../../../utils/logger');
const { User } = require('../../../../models');
const { uploadFile } = require('../../../files/files.service');
const { getEffectiveAccess } = require('../../../memberships/effectivePermissions.service');
const { VIEW_RESTRICTED_PERMISSION } = require('../dlp.constants');
const { govError } = require('../../governance.errors');
const { getEntry } = require('./exports.catalog');
const { readExportParams } = require('./export.params');
const { renderFile } = require('./render');
const { maskRows } = require('./render/mask');
const { maskExportRows } = require('../../data-quality/fieldAccess.export');
const repo = require('./export.repository');
const { inTenant } = require('./export.tx');
const { auditExport } = require('./export.audit');
const crypto = require('node:crypto');

const FILE_CATEGORY = 'dlp-exports';
const stamp = (date) => date.toISOString().slice(0, 16).replace('T', ' ');

/** O pedido APPROVED vira o arquivo: lê as linhas pelo gerador do catálogo com a permissão de agora, mascara, marca d'água, monta o formato e grava cifrado em people.files. */
async function buildFile(tenant, job, transaction, now) {
  const entry = getEntry(job.resourceType);
  if (!entry) throw govError(409, 'GOV_EXPORT_RESOURCE_INVALID', 'Tipo de exportação inválido.');
  const access = await getEffectiveAccess(job.actorUserId, tenant.companyId, transaction);
  if (!access.permissions.includes(entry.permission)) throw govError(403, 'GOV_EXPORT_PERMISSION_LOST', 'A pessoa que pediu a exportação não tem mais a permissão necessária.');
  const params = await readExportParams(tenant, transaction);
  const user = await User.findByPk(job.actorUserId, { transaction });
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: job.actorUserId };
  const collected = await entry.collect(ctx, job.filter || {}, transaction);
  const wanted = entry.columns.filter((c) => (job.columns || []).includes(c.key));
  // M9-D915: com o registro de classificação, cada coluna sai conforme a exportabilidade e a máscara do registro; o pedido já passou pelo guard (WITH_APPROVAL liberado).
  const masked = entry.registryTable
    ? await maskExportRows({ ...ctx, permissions: access.permissions }, entry, wanted, collected.rows || [], { approved: true, maskText: params.maskText, transaction })
    : { columns: wanted, ...maskRows(wanted, collected.rows || [], { canViewRestricted: access.permissions.includes(VIEW_RESTRICTED_PERMISSION), maskText: params.maskText }) };
  const columns = masked.columns;
  const watermarkOn = job.watermark === true || (job.obligations && job.obligations.watermark === true);
  const file = await renderFile({
    format: job.format, entry, columns, rows: masked.rows, ready: collected.ready, separator: params.separator, now: stamp(now),
    watermark: { enabled: watermarkOn, text: params.watermarkText, csvText: params.watermarkCsv, vars: { usuario: (user && (user.name || user.email)) || job.actorUserId, data: stamp(now), job: job.id } },
  });
  const rowCount = collected.ready ? collected.rowCount : masked.rows.length;
  return { file, rowCount, maskedColumns: masked.maskedColumns, watermarkOn };
}

async function finishOk(tenant, job, now, track) {
  return inTenant(tenant, job.actorUserId, async (transaction) => {
    const built = await buildFile(tenant, job, transaction, now);
    const fileName = `${job.resourceType.replace(/[^a-z0-9._-]/gi, '_')}-${now.toISOString().slice(0, 10)}-${job.id.slice(0, 8)}.${built.file.extension}`;
    const stored = await uploadFile({ groupId: tenant.groupId, companyId: tenant.companyId, fileName, mimeType: built.file.mimeType, contentBase64: built.file.buffer.toString('base64'), category: FILE_CATEGORY }, job.actorUserId, transaction);
    track.storageKey = stored.storageKey;
    const sha256 = crypto.createHash('sha256').update(built.file.buffer).digest('hex');
    const ready = await repo.markReady(tenant.companyId, job.id, { id: stored.id, fileName, sha256, rowCount: built.rowCount }, transaction);
    await auditExport(ready, 'generated', { after: { rowCount: built.rowCount, fileSha256: sha256, format: job.format, watermark: built.watermarkOn, maskedColumns: built.maskedColumns }, reason: `Arquivo da exportação ${job.resourceType} gerado (${built.rowCount} linha(s)).` }, transaction);
    return ready;
  });
}

/**
 * Gera o arquivo de um pedido APPROVED (M9-D822 §3.2): APPROVED -> GENERATING -> READY, ou FAILED com o código da causa e o arquivo incompleto apagado. Devolve o pedido final
 * ou null quando outro gerador já levou o pedido (ou ele não está APPROVED).
 */
async function generateExport(tenant, jobId, { now = new Date() } = {}) {
  const job = await inTenant(tenant, null, (transaction) => repo.claim(tenant.companyId, jobId, transaction));
  if (!job) return null;
  const track = {};
  try {
    return await finishOk(tenant, job, now, track);
  } catch (error) {
    if (track.storageKey) { try { diskStorage.deleteFile(track.storageKey); } catch (cleanup) { logger.error({ err: cleanup.message, jobId }, 'dlp.export.cleanup.failed'); } }
    const code = (error && error.code && String(error.code).startsWith('GOV_')) ? error.code : 'GOV_EXPORT_GENERATION_FAILED';
    logger.error({ err: error && error.message, code, jobId }, 'dlp.export.generation.failed');
    return inTenant(tenant, null, async (transaction) => {
      const failed = await repo.markFailed(tenant.companyId, jobId, code, transaction);
      if (failed) await auditExport(failed, 'failed', { after: { errorCode: code }, reason: `A geração da exportação ${job.resourceType} falhou (${code}).` }, transaction);
      return failed;
    });
  }
}

/** Dispara a geração depois da resposta (o pedido é assíncrono); o exportGenerationJob recolhe o que ficou para trás. Desligável no processo por DLP_EXPORT_INLINE_DISABLED=true. */
function scheduleGeneration(tenant, jobId) {
  if (process.env.DLP_EXPORT_INLINE_DISABLED === 'true') return;
  setImmediate(() => { generateExport(tenant, jobId).catch((err) => logger.error({ err: err.message, jobId }, 'dlp.export.schedule.failed')); });
}

module.exports = { generateExport, scheduleGeneration, FILE_CATEGORY };
