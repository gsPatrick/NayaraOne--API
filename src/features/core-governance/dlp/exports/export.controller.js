'use strict';

const { success } = require('../../../../utils/httpResponse');
const { tenantFromAuth } = require('../../governance.module');
const { requestExport } = require('./export.request');
const { getExport } = require('./export.read');
const { downloadExport } = require('./export.download');
const { getExportCatalog } = require('./export.catalog.view');

/** POST /exports -> 202 { exportJobId, status }. A transação da requisição serve às leituras; o guard e a gravação do pedido usam transações próprias (não se desfazem na recusa). */
async function postExport(req, res) {
  const data = await req.withTenantTransaction((transaction) => requestExport({
    tenant: tenantFromAuth(req), actorUserId: req.auth.userId, body: req.body, idempotencyKey: req.get('Idempotency-Key'), transaction,
  }));
  if (data.replayed) res.set('Idempotent-Replay', 'true');
  return success(res, { statusCode: 202, data: { exportJobId: data.exportJobId, status: data.status } });
}

async function getCatalog(req, res) {
  const data = await req.withTenantTransaction((transaction) => getExportCatalog({ tenant: tenantFromAuth(req), permissions: req.auth.permissions, transaction }));
  return success(res, { data });
}

async function getOne(req, res) {
  const data = await req.withTenantTransaction((transaction) => getExport({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId, permissions: req.auth.permissions, id: req.params.id, transaction }));
  return success(res, { data });
}

async function download(req, res) {
  const file = await downloadExport({
    tenant: tenantFromAuth(req), actorUserId: req.auth.userId, permissions: req.auth.permissions, id: req.params.id, exp: req.query.exp, sig: req.query.sig, ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.set('Content-Type', file.mimeType);
  res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.set('X-Content-SHA256', file.sha256);
  res.set('Cache-Control', 'no-store');
  return res.status(200).send(file.buffer);
}

module.exports = { postExport, getCatalog, getOne, download };
