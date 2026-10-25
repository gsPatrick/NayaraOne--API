'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const nfseService = require('./nfse.service');
const dimobService = require('./dimob.service');
const reconciliationService = require('./reconciliation.service');
const exportService = require('./accountingExport.service');
const obligationsService = require('./obligations.service');

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

const downloadInvoiceFile = (kind) =>
  catchAsync(async (req, res) => {
    const file = await req.withTenantTransaction((t) =>
      nfseService.getInvoiceFile(req.params.id, kind, req.auth.groupId, req.auth.companyId, t)
    );
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('X-Content-SHA256', file.sha256);
    return res.status(200).send(file.buffer);
  });

const downloadDimobFile = catchAsync(async (req, res) => {
  const file = await req.withTenantTransaction((t) =>
    dimobService.exportDimobFile(req.params.id, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  return res.status(200).send(file.content);
});

const listDimobRecords = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    dimobService.listDimobRecords(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data });
});

const runReconciliations = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    reconciliationService.runReconciliations(req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data });
});

const listExportCandidates = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    exportService.listExportCandidates(req.query.period, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data });
});

const getExportBatch = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    exportService.getExportBatch(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data });
});

const adjustExportLine = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    exportService.adjustExportLine(req.params.id, req.body?.deltaAmount, req.body?.reason, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data });
});

const importAccountingReturn = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    exportService.importAccountingReturn(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data });
});

const listObligations = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => obligationsService.listObligations(req.auth.groupId, req.auth.companyId, t));
  return success(res, { data });
});

const createObligation = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    obligationsService.ensureObligation(req.body || {}, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data });
});

const completeObligation = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    obligationsService.completeObligation(req.params.id, req.body?.note, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data });
});

module.exports = {
  downloadInvoiceXml: downloadInvoiceFile('xml'),
  downloadInvoicePdf: downloadInvoiceFile('pdf'),
  listDimobRecords,
  downloadDimobFile,
  runReconciliations,
  listExportCandidates,
  getExportBatch,
  adjustExportLine,
  importAccountingReturn,
  listObligations,
  createObligation,
  completeObligation,
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
