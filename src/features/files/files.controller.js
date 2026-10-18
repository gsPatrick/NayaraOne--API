'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const filesService = require('./files.service');
const fileAccessService = require('./fileAccess.service');
const { CaseDocument } = require('../../models');

/**
 * assertNotRestrictedFile — achado real (Marco 8, auditoria pós-DoD, Frente RLS, Ciclo 4): o
 * download/metadado de arquivo deste módulo é genérico (usado por Jurídico/Obras/Pessoas/
 * Correspondente) e só checava autenticação + RLS de empresa — qualquer usuário do tenant que
 * soubesse/adivinhasse um `fileId` conseguia baixar o conteúdo de um documento RESTRICTED (ex.:
 * comprovante de renda) mesmo sem a permissão dedicada `correspondent:documents:read`, que só
 * era aplicada na LISTAGEM (`caseDocuments.service.js#listRequirements`). Isso violava
 * diretamente o invariante do Caderno "corretor não lê extrato/renda de outro caso sem
 * permissão". Guarda aqui, no ponto único de leitura de bytes/metadado de qualquer arquivo —
 * nunca confiar só no filtro da listagem.
 */
async function assertNotRestrictedFile(fileId, permissions, transaction) {
  const restrictedLink = await CaseDocument.findOne({
    where: { fileId, classification: 'RESTRICTED' },
    transaction,
  });
  if (restrictedLink && !permissions.includes('correspondent:documents:read')) {
    throw AppError.forbidden(
      'Este arquivo é um documento restrito. Você não tem permissão para acessá-lo.',
      'FILE_RESTRICTED_DOCUMENT'
    );
  }
}

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
  const item = await req.withTenantTransaction(async (t) => {
    await fileAccessService.assertCanReadFile(req.params.id, req.auth, t);
    await assertNotRestrictedFile(req.params.id, req.auth.permissions, t);
    return filesService.getFileMetadata(req.params.id, t);
  });
  return success(res, { data: item });
});

/**
 * downloadFile — serve os bytes do arquivo com suporte a HTTP Range (RFC 7233). Sem isso, o
 * player nativo de áudio/vídeo do navegador não consegue "pular" pra um ponto do arquivo (ex.:
 * arrastar a barra de progresso) nem fazer streaming progressivo — teria que baixar tudo antes
 * de tocar qualquer coisa, e alguns navegadores nem iniciam a reprodução sem suporte a Range.
 */
const downloadFile = catchAsync(async (req, res) => {
  const file = await req.withTenantTransaction(async (t) => {
    await fileAccessService.assertCanReadFile(req.params.id, req.auth, t);
    await assertNotRestrictedFile(req.params.id, req.auth.permissions, t);
    return filesService.getFileContent(req.params.id, t);
  });
  const total = file.content.length;
  // Defesa em profundidade (auditoria E2E ao vivo, Marco 6, Ciclo 4): uploadFile agora bloqueia
  // mimeType fora da allowlist na ENTRADA, mas um arquivo antigo gravado antes desse fix (ou
  // qualquer outra via de escrita direta no banco) não pode ser servido com Content-Type/
  // Content-Disposition que renderize HTML/script no navegador — força download seguro.
  const isSafeToRenderInline = filesService.ALLOWED_MIME_TYPES.includes(String(file.mimeType || '').toLowerCase());
  const mimeType = isSafeToRenderInline ? file.mimeType : 'application/octet-stream';
  const disposition = isSafeToRenderInline && req.query.download !== '1' ? 'inline' : 'attachment';

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

module.exports = { uploadFile, getFileMetadata, downloadFile, assertNotRestrictedFile };
