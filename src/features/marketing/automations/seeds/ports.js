'use strict';

/**
 * Portas das automações prontas para outras áreas do Marketing (sem import entre áreas): a validação de URL externa (regra de URL da M9-D433, que mora no rastreamento) é
 * registrada por marketing/index.js. Sem validador registrado, nenhuma URL é aceita (falha fechada).
 */
let assertAllowedUrl = null;
const registerUrlGuard = (fn) => { if (typeof fn !== 'function') throw new TypeError('O validador de URL deve ser uma função.'); assertAllowedUrl = fn; };
const clearUrlGuard = () => { assertAllowedUrl = null; };
/** Devolve a URL normalizada ou lança 422 MKT_URL_NOT_ALLOWED (a regra única de URL externa). */
const checkUrl = (rawUrl, ctx) => {
  if (!assertAllowedUrl) throw new Error('Validador de URL externa não registrado (carregue o módulo de Marketing).');
  return assertAllowedUrl(rawUrl, ctx);
};

module.exports = { registerUrlGuard, clearUrlGuard, checkUrl };
