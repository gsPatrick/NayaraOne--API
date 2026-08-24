'use strict';

/**
 * Envolve um controller assíncrono repassando qualquer rejeição de Promise
 * para o middleware de erro (next), evitando try/catch repetido em cada controller.
 */
function catchAsync(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = catchAsync;
