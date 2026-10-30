'use strict';

const repo = require('./media.repository');
const { fileInfo } = require('./media.files');
const { assertAuthorized } = require('./media.service');
const { mediaNotAuthorized } = require('./video.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sizeOf = (file) => (file && file.size_bytes !== undefined ? Number(file.size_bytes) : null);

/** Mídia original usada direto: o arquivo autorizado (formato pelo tipo do arquivo; proporção e duração não são conhecidas sem examinar o vídeo, ficam nulas). */
async function summaryOfOriginal(fileId, transaction) {
  const { authorization, file } = await assertAuthorized(fileId, transaction);
  const render = authorization.origin === 'RENDER_PROJETO';
  return {
    tipo: 'ORIGINAL', arquivoId: fileId, sha256: authorization.sha256, origem: authorization.origin, derivadoDe: [{ fileId, sha256: authorization.sha256 }], transformLog: { operations: [], order: [fileId], syntheticKinds: render ? ['RENDER'] : [] },
    sintetico: render, tiposSinteticos: render ? ['RENDER'] : [], formato: String(file.mime_type || '').startsWith('video/') ? 'VIDEO' : 'IMAGE', proporcao: null, duracaoS: null, tamanhoBytes: sizeOf(file), mimeType: file.mime_type,
  };
}

/** Derivado: o arquivo novo da montagem; todas as origens continuam autorizadas e com o mesmo hash de quando foi montado. */
async function summaryOfDerivative(derivative, transaction) {
  for (const source of derivative.derived_from) {
    const { authorization } = await assertAuthorized(source.fileId, transaction);
    if (authorization.sha256 !== source.sha256) throw mediaNotAuthorized({ reason: 'FILE_CHANGED', fileId: source.fileId });
  }
  const file = await fileInfo(derivative.derived_file_id, transaction);
  return {
    tipo: 'DERIVADO', arquivoId: derivative.derived_file_id, derivadoId: derivative.id, sha256: derivative.derived_sha256, origem: 'MONTAGEM', derivadoDe: derivative.derived_from, transformLog: derivative.transform_log,
    sintetico: derivative.synthetic, tiposSinteticos: derivative.synthetic_kinds, formato: derivative.format, proporcao: derivative.aspect_ratio, duracaoS: derivative.duration_s, tamanhoBytes: sizeOf(file), mimeType: file ? file.mime_type : 'video/mp4',
  };
}

/**
 * Resolve o `midiaId` do conteúdo (M9-D426 regra 1): o id de um derivado da montagem ou o de um arquivo autorizado. Sem autorização (ou revogada, ou arquivo trocado):
 * 422 MKT_MEDIA_NOT_AUTHORIZED. Devolve o resumo que viaja no corpo da versão.
 */
async function resolveMedia(mediaId, transaction) {
  const id = String(mediaId || '').trim();
  if (!UUID_RE.test(id)) throw mediaNotAuthorized({ reason: 'NOT_AUTHORIZED', mediaId: id.slice(0, 60) });
  const derivative = await repo.findDerivative(id, transaction);
  return derivative ? summaryOfDerivative(derivative, transaction) : summaryOfOriginal(id, transaction);
}

module.exports = { resolveMedia };
