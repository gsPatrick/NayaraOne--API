'use strict';

const { File } = require('../../../models');
const { canReadFile } = require('../../files/fileAccess.service');
const E = require('./email.errors');
const { ATTACHMENT_SCALE, MIME_BY_EXTENSION } = require('./email.constants');

const extensionOf = (fileName) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(fileName || ''));
  const e = m ? m[1].toLowerCase() : '';
  return e === 'jpeg' ? 'jpg' : e;
};

/** Classificação do documento dentro do teto da empresa? Sem classificação (nula, a NAY nunca adivinha) ou RESTRICTED ficam de fora: falha fechada. */
function classificationAllowed(classification, maxClassification) {
  const posicao = ATTACHMENT_SCALE.indexOf(classification);
  return posicao >= 0 && posicao <= ATTACHMENT_SCALE.indexOf(maxClassification);
}

function assertTypeAllowed(file, params) {
  const extension = extensionOf(file.fileName);
  if (!extension || !params.allowedTypes.includes(extension)) throw E.typeNotAllowed(file.id, extension || null);
  const esperados = MIME_BY_EXTENSION[extension];
  if (esperados && file.mimeType && !esperados.includes(String(file.mimeType).toLowerCase())) throw E.typeNotAllowed(file.id, extension);
}

/**
 * Anexos autorizados e classificados (M9-D234 3.2 item 3). Cada arquivo, nesta ordem: existe na empresa (404), o usuário que envia tem acesso a ele pelo módulo dono
 * (403 NOT_AUTHORIZED), documento classificado dentro do teto (403 CLASSIFICATION_BLOCKED: o link seguro é o caminho para RESTRICTED), antivírus CLEAN (422 NOT_CLEAN) e
 * tipo da allowlist (422 TYPE_NOT_ALLOWED); por fim a soma dos tamanhos dentro do limite (413 TOO_LARGE). Devolve a referência de cada anexo (sem o conteúdo).
 */
async function validateAttachments({ auth, fileIds, params, transaction }) {
  const ids = [...new Set([].concat(fileIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return [];
  if (ids.length > params.maxAttachments) throw E.tooManyAttachments(params.maxAttachments);
  const arquivos = await File.findAll({ where: { id: ids, companyId: auth.companyId }, transaction });
  const porId = new Map(arquivos.map((f) => [f.id, f]));
  const anexos = [];
  let total = 0;
  for (const id of ids) {
    const file = porId.get(id);
    if (!file) throw E.notFound(id);
    if (!(await canReadFile(file, auth, transaction))) throw E.notAuthorized(id);  
    if (!classificationAllowed(file.classification, params.maxClassification)) throw E.classificationBlocked(id, file.classification ? 'ABOVE_LIMIT' : 'UNCLASSIFIED');
    if (file.scanStatus !== 'CLEAN') throw E.notClean(id);
    assertTypeAllowed(file, params);
    total += Number(file.sizeBytes) || 0;
    anexos.push({ fileId: file.id, fileName: file.fileName, mimeType: file.mimeType || null, sizeBytes: Number(file.sizeBytes) || 0, sha256: file.checksumSha256 || null, classification: file.classification });
  }
  if (total > params.maxAttachmentBytes) throw E.tooLarge(total, params.maxAttachmentBytes);
  return anexos;
}

module.exports = { validateAttachments, classificationAllowed, extensionOf };
