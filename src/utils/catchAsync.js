'use strict';

/**
 * Envolve um controller assíncrono repassando qualquer rejeição de Promise
 * para o middleware de erro (next), evitando try/catch repetido em cada controller.
 */
function catchAsync(fn) {
  function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  }
  // Mantém as marcas do handler (ex.: impactActionKey do M9-D852) para a varredura do inventário de ações destrutivas.
  return Object.assign(wrapped, fn);
}

module.exports = catchAsync;
