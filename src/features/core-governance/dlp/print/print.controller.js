'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const { tenantFromAuth } = require('../../governance.module');
const { contentDisposition } = require('../../../files/contentDisposition');
const { requestPrint } = require('./print.request');
const { servePrint } = require('./print.serve');

const where = (req) => ({ tenant: tenantFromAuth(req), auth: req.auth, ip: req.ip, userAgent: req.get('user-agent') });

/** POST /dlp/print-events -> 201 { exportJobId, status, printUrl, expiresAt, classification, watermark }. */
const postPrintEvent = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((transaction) => requestPrint({ ...where(req), body: req.body, transaction }));
  res.set('Cache-Control', 'no-store');
  return success(res, { statusCode: 201, data });
});

/** GET /dlp/print-events/:id/pdf -> o PDF (único formato), de uso único. */
const getPrintPdf = catchAsync(async (req, res) => {
  const file = await servePrint({ ...where(req), jobId: req.params.id, exp: req.query.exp, sig: req.query.sig });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition('inline', file.fileName), 'Cache-Control': 'no-store', 'X-Watermark': file.watermark ? 'applied' : 'none' });
  return res.status(200).send(file.buffer);
});

module.exports = { postPrintEvent, getPrintPdf };
