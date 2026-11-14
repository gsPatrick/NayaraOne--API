'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const { tenantFromAuth } = require('../../governance.module');
const { assertCanReadFile } = require('../../../files/fileAccess.service');
const { rejectRestrictedUnlessAllowed } = require('../../../files/restrictedDocument.guard');
const { contentDisposition } = require('../../../files/contentDisposition');
const { downloadAccess } = require('./download.single');
const { requestBatch } = require('./download.batch');
const { serveGrant } = require('./download.serve');
const { assertUuid } = require('./download.input');
const { recordEvidenceFileAccess } = require('../../../../modules/legal/cases/evidenceFileAccess');

/** O que a API devolve do endereço assinado. */
const grantView = (grant) => ({ exportJobId: grant.exportJobId, status: grant.status, downloadUrl: grant.url, expiresAt: grant.expiresAt, classification: grant.classification, watermark: grant.watermark });

function sendFile(res, file) {
  res.set({ 'Content-Type': file.mimeType, 'Content-Disposition': contentDisposition('attachment', file.fileName), 'Cache-Control': 'no-store', 'X-Watermark': file.watermark ? 'applied' : 'none' });
  if (file.originalSha256) res.set('X-Original-SHA256', file.originalSha256);
  return res.status(200).send(file.buffer);
}

const where = (req) => ({ tenant: tenantFromAuth(req), auth: req.auth, ip: req.ip, userAgent: req.get('user-agent') });

const getDownload = catchAsync(async (req, res) => {
  const out = await req.withTenantTransaction(async (transaction) => {
    const id = assertUuid(req.params.id);
    const { file, restricted, ownership } = await assertCanReadFile(id, req.auth, transaction);
    rejectRestrictedUnlessAllowed(restricted, req.auth.permissions, file);
    const out = await downloadAccess({ ...where(req), file, restricted, query: req.query, transaction });
    // Fechamento M5 (JUR-010): download de prova do Jurídico entra na cadeia de custódia (bytes entregues ou endereço emitido).
    await recordEvidenceFileAccess({ file, ownership, auth: req.auth, kind: out.file ? 'CONTENT' : 'DOWNLOAD_GRANT', ip: req.ip }, transaction);
    return out;
  });
  if (out.file) return sendFile(res, out.file);
  res.set('Cache-Control', 'no-store');
  return success(res, { data: grantView(out.grant) });
});

const postBatch = catchAsync(async (req, res) => {
  const grant = await req.withTenantTransaction((transaction) => requestBatch({ ...where(req), body: req.body, transaction }));
  res.set('Cache-Control', 'no-store');
  return success(res, { statusCode: 201, data: grantView(grant) });
});

const getGranted = catchAsync(async (req, res) => {
  const file = await serveGrant({ ...where(req), jobId: req.params.jobId, exp: req.query.exp, sig: req.query.sig });
  return sendFile(res, file);
});

module.exports = { getDownload, postBatch, getGranted };
