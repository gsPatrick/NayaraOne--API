'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const filesService = require('./files.service');
const fileAccessService = require('./fileAccess.service');
const { CaseDocument } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// Nome do arquivo no cabeçalho: versão simples (ASCII) para navegadores antigos e a versão UTF-8 (RFC 5987) com acentos.
function contentDisposition(disposition, fileName) {
  const clean = String(fileName || 'arquivo').replace(/[\r\n"\\]/g, '_');
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

// Quem leu documento restrito (renda, extrato, identidade) fica registrado.
async function auditRestrictedRead(file, auth, action, transaction) {
  await registrarAuditoria(
    { groupId: auth.groupId, companyId: auth.companyId, actorUserId: auth.userId, action, entityType: 'File', entityId: file.id, reason: `Documento restrito "${file.fileName}" ${action === 'files.read_restricted' ? 'aberto ou baixado' : 'consultado'} por uma pessoa.` },
    transaction
  );
}

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
function rejectRestrictedUnlessAllowed(restricted, permissions) {
  if (restricted && !(permissions || []).includes('correspondent:documents:read')) {
    throw AppError.forbidden(
      'Este arquivo é um documento restrito. Você não tem permissão para acessá-lo.',
      'FILE_RESTRICTED_DOCUMENT'
    );
  }
}

async function assertNotRestrictedFile(fileId, permissions, transaction) {
  const restrictedLink = await CaseDocument.findOne({
    where: { fileId, classification: 'RESTRICTED' },
    transaction,
  });
  rejectRestrictedUnlessAllowed(Boolean(restrictedLink), permissions);
}

const uploadFile = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    filesService.uploadFile(
      // O tenant do token sempre vence: groupId/companyId do corpo são ignorados (D1).
      { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId },
      req.auth.userId,
      t
    )
  );
  return success(res, { statusCode: 201, data: item });
});

const getFileMetadata = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction(async (t) => {
    // A checagem de documento RESTRICTED vem na mesma consulta de vínculos (fileAccess.service).
    const { file, restricted } = await fileAccessService.assertCanReadFile(req.params.id, req.auth, t);
    rejectRestrictedUnlessAllowed(restricted, req.auth.permissions);
    if (restricted) await auditRestrictedRead(file, req.auth, 'files.read_restricted_metadata', t);
    return file;
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
    const { file: metadata, restricted } = await fileAccessService.assertCanReadFile(req.params.id, req.auth, t);
    rejectRestrictedUnlessAllowed(restricted, req.auth.permissions);
    const withContent = await filesService.getFileContent(req.params.id, t, req.auth.userId, metadata);
    if (restricted) await auditRestrictedRead(metadata, req.auth, 'files.read_restricted', t);
    return withContent;
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
  res.set('Content-Disposition', contentDisposition(disposition, file.fileName));
  res.set('Cache-Control', 'private, max-age=0, must-revalidate');

  const range = req.headers.range;
  // Sem Range, ou com vários intervalos (que a API não monta), responde o arquivo inteiro (RFC 7233).
  if (!range || range.includes(',')) {
    res.set('Content-Length', String(total));
    return res.status(200).send(file.content);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    res.set('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  let start;
  let end;
  if (match[1] === '') {
    // "bytes=-N": os ÚLTIMOS N bytes.
    const suffix = parseInt(match[2], 10);
    if (!(suffix > 0)) {
      res.set('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    start = Math.max(total - suffix, 0);
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    // Fim além do tamanho do arquivo é truncado no último byte (leitores de PDF/mídia pedem blocos fixos).
    end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start >= total || start > end) {
    res.set('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  res.set('Content-Length', String(end - start + 1));
  return res.send(file.content.subarray(start, end + 1));
});

module.exports = { uploadFile, getFileMetadata, downloadFile, assertNotRestrictedFile };
