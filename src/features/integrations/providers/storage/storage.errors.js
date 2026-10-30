'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros do armazenamento de objetos (M9-D242 seção 4). O texto é para a pessoa; o detalhe técnico fica em `details`. */
module.exports = {
  keyForbidden: (reason) => AppError.forbidden('Acesso negado ao objeto.', 'INTEGRATION_STORAGE_KEY_FORBIDDEN', reason ? { reason } : undefined),
  sha256Mismatch: () => AppError.unprocessable('O conteúdo enviado não confere com o hash informado.', 'INTEGRATION_STORAGE_SHA256_MISMATCH'),
  notFound: () => AppError.notFound('O objeto não foi encontrado no armazenamento.', 'INTEGRATION_STORAGE_OBJECT_NOT_FOUND'),
  integrity: (reason) => AppError.conflict('O conteúdo do objeto não confere com o que foi gravado: a leitura foi bloqueada.', 'INTEGRATION_STORAGE_INTEGRITY_VIOLATION', reason ? { reason } : undefined),
  deleteForbidden: () => AppError.forbidden('A remoção de objetos só pode ser feita pela retenção de dados.', 'INTEGRATION_STORAGE_DELETE_FORBIDDEN'),
  tooLarge: (maxBytes) => AppError.badRequest('O objeto excede o tamanho máximo permitido.', 'INTEGRATION_STORAGE_TOO_LARGE', { maxBytes }),
  bodyMissing: () => AppError.badRequest('O conteúdo do objeto não foi informado.', 'INTEGRATION_STORAGE_BODY_MISSING'),
};
