'use strict';

const { achar, exigir } = require('./source');

const NOME = 'guard_public_payload_only';

/** Canal público só recebe PublicPayload (a marca do sanitizePublicFields); ninguém mais marca. */
function verificar(raiz) {
  const problemas = [
    ...exigir(raiz, 'publications/adapters/sendToChannel.js', /assertPublicPayload\(/, 'sendToChannel deve recusar (MKT_INTERNAL_DTO_FORBIDDEN) o que não é PublicPayload nos canais de publicação'),
    ...exigir(raiz, 'content/sanitize.js', /markPublicPayload\(/, 'sanitizePublicFields deve marcar o payload limpo como PublicPayload'),
    ...exigir(raiz, 'security/publicPayload.js', /MKT_INTERNAL_DTO_FORBIDDEN/, 'a recusa de DTO interno deve existir com o código MKT_INTERNAL_DTO_FORBIDDEN'),
  ];
  const marcadores = achar(raiz, /\bmarkPublicPayload\(/, { somente: (a) => a !== 'content/sanitize.js' && a !== 'security/publicPayload.js' });
  return [...problemas, ...marcadores.map((a) => ({ arquivo: a.arquivo, linha: a.linha, regra: 'só o sanitizePublicFields marca PublicPayload; marcar à mão deixa um DTO interno passar por público' }))];
}

module.exports = { NOME, verificar };
