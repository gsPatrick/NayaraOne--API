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

const getFileMetadata = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => filesService.getFileMetadata(req.params.id, t));
  return success(res, { data: item });
});

/**
 * downloadFile — serve os bytes do arquivo com suporte a HTTP Range (RFC 7233). Sem isso, o
 * player nativo de áudio/vídeo do navegador não consegue "pular" pra um ponto do arquivo (ex.:
 * arrastar a barra de progresso) nem fazer streaming progressivo — teria que baixar tudo antes
 * de tocar qualquer coisa, e alguns navegadores nem iniciam a reprodução sem suporte a Range.
 */
const downloadFile = catchAsync(async (req, res) => {
  const file = await req.withTenantTransaction((t) => filesService.getFileContent(req.params.id, t));
  const total = file.content.length;
  const mimeType = file.mimeType || 'application/octet-stream';
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';

  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', mimeType);
  res.set('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.fileName)}"`);
  res.set('Cache-Control', 'private, max-age=0, must-revalidate');

  const range = req.headers.range;
  if (!range) {
    res.set('Content-Length', String(total));
    return res.status(200).send(file.content);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.set('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : total - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
    res.set('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  res.set('Content-Length', String(end - start + 1));
  return res.send(file.content.subarray(start, end + 1));
});

module.exports = { uploadFile, getFileMetadata, downloadFile };
