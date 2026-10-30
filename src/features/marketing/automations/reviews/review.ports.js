'use strict';

/** Porta do pedido de avaliação para o rastreamento (sem import entre áreas): quem monta o Marketing registra o criador de link rastreável da M9-D431. */
let createTrackingLink = null;
const registerTrackingLinkPort = (fn) => { if (typeof fn !== 'function') throw new TypeError('O criador de link rastreável deve ser uma função.'); createTrackingLink = fn; };
const createLink = (...args) => {
  if (!createTrackingLink) throw new Error('Criador de link rastreável não registrado (carregue o módulo de Marketing).');
  return createTrackingLink(...args);
};

module.exports = { registerTrackingLinkPort, createLink };
