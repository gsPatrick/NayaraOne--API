'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const filesService = require('./files.service');

const uploadFile = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    filesService.uploadFile(
      { groupId: req.auth.groupId, companyId: req.auth.companyId, ...req.body },
      req.auth.userId,
      t
    )
  );
  return success(res, { statusCode: 201, data: item });
});

const downloadFile = catchAsync(async (req, res) => {
  const file = await req.withTenantTransaction((t) => filesService.getFileContent(req.params.id, t));
  res.set('Content-Type', file.mimeType || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`);
  return res.status(200).send(file.content);
});

module.exports = { uploadFile, downloadFile };
