'use strict';

const crypto = require('node:crypto');
const { getFileContent } = require('../../../files/files.service');
const { assertCanReadFile } = require('../../../files/fileAccess.service');
const { rejectRestrictedUnlessAllowed } = require('../../../files/restrictedDocument.guard');
const grants = require('../grants/grant.service');
const { buildZip } = require('../exports/render/zip');
const { auditDownloaded } = require('./download.audit');
const { markAll, watermarkText } = require('./download.mark');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const safeName = (name) => String(name || 'arquivo').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 200);

/** Nomes de entrada do zip sem repetição (o mesmo nome em dois anexos ganha um número). */
function zipEntries(items) {
  const used = new Map();
  return items.map((item) => {
    const base = safeName(item.fileName);
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    return { name: seen ? base.replace(/(\.[^.]*)?$/, `-${seen + 1}$1`) : base, data: item.buffer };
  });
}

async function readItems(tenant, auth, ids, transaction) {
  const items = [];
  for (const id of ids) {
    // a leitura vale agora: a permissão do módulo dono pode ter mudado desde o pedido
    const { file, restricted } = await assertCanReadFile(id, auth, transaction); // eslint-disable-line no-await-in-loop
    rejectRestrictedUnlessAllowed(restricted, auth.permissions, file);
    const withContent = await getFileContent(id, transaction, auth.userId, file); // eslint-disable-line no-await-in-loop
    items.push({ id, buffer: withContent.getDataValue('content'), mimeType: withContent.mimeType, fileName: withContent.fileName, sha256: withContent.checksumSha256 || sha256(withContent.getDataValue('content')) });
  }
  return items;
}

/**
 * Entrega o que o pedido aprovado liberou (M9-D920 §3.3 e §3.4): lê os arquivos (decifrados e conferidos pelo hash), aplica a marca por usuário quando o pedido a exige (uma falha
 * recusa o download inteiro e o pedido termina FAILED: nunca sai sem a marca), usa o endereço (uma vez só), audita com IP e agente e devolve { buffer, mimeType, fileName }. Lote
 * vira zip (o zip em si não leva marca: cada arquivo dentro leva). O original guardado e o hash dele nunca mudam. `job` = { id, classification, watermark, fileIds }; sem `job.id`
 * (LOW/MEDIUM direto) nada é consumido.
 */
async function deliverFiles({ tenant, auth, job, ip, userAgent, params, now = new Date(), transaction }) {
  const items = await readItems(tenant, auth, job.fileIds, transaction);
  let outgoing = items;
  if (job.watermark) {
    try {
      const text = await watermarkText({ template: params.watermarkText, actorUserId: auth.userId, jobId: job.id || items[0].id, now, transaction });
      outgoing = await markAll(items, text, { maxPages: params.watermarkPages });
    } catch (error) {
      if (job.id) await grants.fail(tenant, auth.userId, job.id, error.code || 'GOV_FILE_WATERMARK_FAILED');
      throw error;
    }
  }
  if (job.id) await grants.consume(tenant, job.id, transaction);
  const single = outgoing.length === 1;
  const buffer = single ? outgoing[0].buffer : buildZip(zipEntries(outgoing), now);
  const out = single ? { buffer, mimeType: outgoing[0].mimeType, fileName: outgoing[0].fileName } : { buffer, mimeType: 'application/zip', fileName: `arquivos-${now.toISOString().slice(0, 10)}.zip` };
  await auditDownloaded({ tenant, actorUserId: auth.userId, job: job.id ? job : null, classification: job.classification, items, delivered: { sha256: sha256(buffer) }, watermark: Boolean(job.watermark), ip, userAgent }, transaction);
  return { ...out, originalSha256: single ? items[0].sha256 : null, watermark: Boolean(job.watermark) };
}

module.exports = { deliverFiles, zipEntries };
