'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const nfseService = require('./nfse.service');
const dimobService = require('./dimob.service');
const reconciliationService = require('./reconciliation.service');
const exportService = require('./accountingExport.service');

const requestInvoice = catchAsync(async (req, res) => {
  const invoiceRequest = await req.withTenantTransaction((t) =>
    nfseService.requestInvoice(req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: invoiceRequest });
});

const checkInvoiceStatus = catchAsync(async (req, res) => {
  const invoiceRequest = await req.withTenantTransaction((t) =>
    nfseService.checkInvoiceStatus(req.params.id, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: invoiceRequest });
});

const cancelInvoice = catchAsync(async (req, res) => {
  const invoiceRequest = await req.withTenantTransaction((t) =>
    nfseService.cancelInvoice(req.params.id, req.body?.reason, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: invoiceRequest });
});

const listInvoiceRequests = catchAsync(async (req, res) => {
  const invoices = await req.withTenantTransaction((t) => nfseService.listInvoiceRequests(req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: invoices });
});

const getInvoiceEvents = catchAsync(async (req, res) => {
  const events = await req.withTenantTransaction((t) =>
    nfseService.getInvoiceEvents(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: events });
});

const generateDimobBatch = catchAsync(async (req, res) => {
  const batch = await req.withTenantTransaction((t) =>
    dimobService.generateDimobBatch(Number(req.body?.referenceYear), req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: batch });
});

const closeDimobBatch = catchAsync(async (req, res) => {
  const batch = await req.withTenantTransaction((t) =>
    dimobService.closeDimobBatch(req.params.id, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: batch });
});

const listDimobBatches = catchAsync(async (req, res) => {
  const batches = await req.withTenantTransaction((t) =>
    dimobService.listDimobBatches(req.query.referenceYear ? Number(req.query.referenceYear) : null, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: batches });
});

const listReconciliations = catchAsync(async (req, res) => {
  const reconciliations = await req.withTenantTransaction((t) =>
    reconciliationService.listReconciliations(req.query.status || null, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: reconciliations });
});

const resolveReconciliation = catchAsync(async (req, res) => {
  const reconciliation = await req.withTenantTransaction((t) =>
    reconciliationService.resolveReconciliation(req.params.id, req.body?.reason, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: reconciliation });
});

const createExportBatch = catchAsync(async (req, res) => {
  const batch = await req.withTenantTransaction((t) =>
    exportService.createExportBatch(req.body?.referencePeriod, req.body?.lines, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: batch });
});

const listExportBatches = catchAsync(async (req, res) => {
  const batches = await req.withTenantTransaction((t) => exportService.listExportBatches(req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: batches });
});

module.exports = {
  requestInvoice,
  checkInvoiceStatus,
  cancelInvoice,
  listInvoiceRequests,
  getInvoiceEvents,
  generateDimobBatch,
  closeDimobBatch,
  listDimobBatches,
  listReconciliations,
  resolveReconciliation,
  createExportBatch,
  listExportBatches,
};
