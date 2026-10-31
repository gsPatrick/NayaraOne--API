'use strict';

const guardService = require('../guard.service');
const { blockedError } = require('../guard.reasons');
const { decideDownload, issueDownloadGrant } = require('./download.request');
const { deliverFiles } = require('./download.deliver');
const { effectiveClass } = require('./download.class');
const { parseDownloadInput } = require('./download.input');
const { auditDownloaded } = require('./download.audit');

const asJob = (decided, id) => ({ id, classification: decided.classification, watermark: decided.watermark, fileIds: [decided.fileId] });

/** Leitura em tela (sem baixar) de HIGH: política VIEW da classe (modo leve; audita o que a política exige). LOW e MEDIUM seguem livres; RESTRICTED nunca é "só ver" (vira download). */
async function viewDecision({ tenant, auth, ip, file, classification }) {
  if (classification !== 'HIGH') return;
  const decision = await guardService.decide(tenant, {
    action: 'VIEW', resourceType: 'files.file', resourceIds: [file.id], minClassification: classification, permissions: auth.permissions, actorUserId: auth.userId, ip,
  });
  if (decision.decision === 'DENY') throw blockedError(decision, decision.justificationMin);
}

/**
 * GET /files/:id/content (M9-D920 §3.3): sem `download=1`, HIGH é leitura em tela (VIEW) e LOW/MEDIUM passam como sempre; com `download=1` ou RESTRICTED (sempre MFA e justificativa) o
 * pedido passa pelo guard como DOWNLOAD e, aprovado, o arquivo sai nesta mesma resposta (o endereço de uso único é consumido na hora). Devolve null quando o conteúdo segue como
 * está; senão { buffer, mimeType, fileName } com a marca já aplicada. `file` traz o conteúdo já lido pelo controller (só para o hash da auditoria simples).
 */
async function contentAccess({ tenant, auth, ip, userAgent, file, restricted, query, transaction }) {
  const classification = effectiveClass(file, restricted);
  const download = query.download === '1' || classification === 'RESTRICTED';
  if (!download) { await viewDecision({ tenant, auth, ip, file, classification }); return null; }
  const decided = await decideDownload({ tenant, auth, ip, items: [{ file, restricted }], input: parseDownloadInput(query), transaction });
  decided.fileId = file.id;
  if (decided.mode === 'direct') {
    if (decided.watermark) return deliverFiles({ tenant, auth, job: asJob(decided, null), ip, userAgent, params: decided.params, transaction });
    await auditDownloaded({ tenant, actorUserId: auth.userId, job: null, classification, items: [{ id: file.id, fileName: file.fileName, sha256: file.checksumSha256 }], delivered: { sha256: file.checksumSha256 }, watermark: false, ip, userAgent }, transaction);
    return null;
  }
  return deliverFiles({ tenant, auth, job: asJob(decided, decided.decision.job.id), ip, userAgent, params: decided.params, transaction });
}

/**
 * GET /files/:id/download (M9-D920 §3.3): LOW e MEDIUM baixam direto ({ file }); HIGH e RESTRICTED passam pelo guard e recebem o endereço assinado de uso único ({ grant }), que
 * vale o menor entre 15 minutos (`governanca.dlp.download.url_min`) e o teto da classe, gravado em export_jobs.expires_at.
 */
async function downloadAccess({ tenant, auth, ip, userAgent, file, restricted, query, transaction }) {
  const decided = await decideDownload({ tenant, auth, ip, items: [{ file, restricted }], input: parseDownloadInput(query), transaction });
  decided.fileId = file.id;
  if (decided.mode === 'direct') return { file: await deliverFiles({ tenant, auth, job: asJob(decided, null), ip, userAgent, params: decided.params, transaction }) };
  return { grant: await issueDownloadGrant(tenant, auth, decided) };
}

module.exports = { contentAccess, downloadAccess };
