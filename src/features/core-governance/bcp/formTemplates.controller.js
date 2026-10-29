'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./formTemplates.service');
const printService = require('./formPrint.service');

const actor = (req) => ({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId });

async function list(req, res) {
  const { items, pagination } = await req.withTenantTransaction((transaction) => service.listForUser({ ...actor(req), query: req.query, transaction }));
  return success(res, { data: items, pagination });
}

async function print(req, res) {
  const file = await req.withTenantTransaction((transaction) => printService.printTemplate({
    ...actor(req), sector: req.params.sector, formType: req.params.formType, query: req.query, transaction,
  }));
  res.set('Content-Type', file.mimeType);
  res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.set('Cache-Control', 'no-store');
  return res.status(200).send(file.buffer);
}

module.exports = { list, print };
