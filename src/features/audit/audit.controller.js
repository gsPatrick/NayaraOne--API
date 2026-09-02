'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const auditService = require('./audit.service');

const list = catchAsync(async (req, res) => {
  const entries = await req.withTenantTransaction((transaction) =>
    auditService.listAuditLog(transaction, {
      userId: req.query.userId,
      entityType: req.query.entityType,
      action: req.query.action,
      entityId: req.query.entityId,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    })
  );
  return success(res, { data: entries });
});

const getOne = catchAsync(async (req, res) => {
  const entry = await req.withTenantTransaction((transaction) => auditService.getAuditLogEntry(req.params.id, transaction));
  return success(res, { data: entry });
});

module.exports = { list, getOne };
