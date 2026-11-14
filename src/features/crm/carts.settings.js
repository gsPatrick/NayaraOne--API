'use strict';

/**
 * Parâmetros do carrinho de imóveis (livro do Marco 3 §14: "Gera link/coleção com expiração e tracking"). O livro não fixa o
 * prazo: vira parâmetro da empresa (regra do Patrick; DI-M3IM-6), editável em Configurações > Imóveis e CRM. Padrão = o
 * comportamento anterior do código (7 dias). Vale para o carrinho criado sem data própria de expiração.
 */
const LINK_EXPIRATION_DAYS_KEY = 'crm.cart.link_expiration_days';
const LINK_EXPIRATION_DAYS_DEFAULT = 7;
const LINK_EXPIRATION_DAYS_MAX = 90;

const CART_SETTINGS_SCHEMA = Object.freeze({
  [LINK_EXPIRATION_DAYS_KEY]: { type: 'integer', min: 1, max: LINK_EXPIRATION_DAYS_MAX },
});

module.exports = { CART_SETTINGS_SCHEMA, LINK_EXPIRATION_DAYS_KEY, LINK_EXPIRATION_DAYS_DEFAULT, LINK_EXPIRATION_DAYS_MAX };
