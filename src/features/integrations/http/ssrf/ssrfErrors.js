'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros da busca de URL de terceiro (M9-D245 4). A mensagem é genérica; o motivo exato fica em `reason` (log e auditoria), nunca na resposta. */
function blocked(reason, host) {
  const err = new AppError('Endereço não permitido.', 422, 'INTEGRATION_SSRF_BLOCKED');
  Object.defineProperty(err, 'reason', { value: reason, enumerable: false });
  Object.defineProperty(err, 'host', { value: host || null, enumerable: false });
  return err;
}

const tooLarge = () => new AppError('O arquivo remoto excede o tamanho permitido.', 413, 'INTEGRATION_FETCH_TOO_LARGE');
const unsupportedMedia = () => new AppError('Tipo de arquivo remoto não permitido.', 415, 'INTEGRATION_FETCH_UNSUPPORTED_MEDIA');
const fetchFailed = () => new AppError('Não foi possível baixar o arquivo remoto.', 502, 'INTEGRATION_FETCH_FAILED');
const fetchTimeout = () => new AppError('O arquivo remoto demorou demais para responder.', 504, 'INTEGRATION_FETCH_TIMEOUT');

module.exports = { blocked, tooLarge, unsupportedMedia, fetchFailed, fetchTimeout };
