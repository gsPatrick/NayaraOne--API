'use strict';

/**
 * M9-D424 — parâmetros do pedido de avaliação (aba Marketing): as duas notas de corte (positiva a partir de, negativa até; nota entre as duas não tem ação), o endereço da
 * avaliação pública (vazio por padrão: sem ele o pedido fica FAILED e nada é enviado), a plataforma e o endereço público onde os links rastreáveis (/t/{código}) são servidos.
 */
const MIN_POSITIVE_KEY = 'marketing.review.nota_minima_positiva';
const MAX_NEGATIVE_KEY = 'marketing.review.nota_maxima_negativa';
const REVIEW_URL_KEY = 'marketing.review.url_avaliacao';
const PLATFORM_KEY = 'marketing.review.plataforma';
const LINK_BASE_KEY = 'marketing.review.url_base_rastreio';

const REVIEW_DEFAULTS = Object.freeze({ [MIN_POSITIVE_KEY]: 4, [MAX_NEGATIVE_KEY]: 2, [PLATFORM_KEY]: 'GOOGLE' });
const SCORE = { type: 'integer', min: 1, max: 5 };
const REVIEW_SETTINGS_SCHEMA = {
  [MIN_POSITIVE_KEY]: SCORE, [MAX_NEGATIVE_KEY]: SCORE, [REVIEW_URL_KEY]: { type: 'string' }, [PLATFORM_KEY]: { type: 'string' }, [LINK_BASE_KEY]: { type: 'string' },
};

const score = (value, key) => (Number.isInteger(value) && value >= 1 && value <= 5 ? value : REVIEW_DEFAULTS[key]);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

async function readReviewParams(tenant, transaction) {
  const { getSetting } = require('../../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const read = (key, fallback) => getSetting(key, tenant, transaction, fallback);
  const [min, max, url, platform, linkBase] = await Promise.all([
    read(MIN_POSITIVE_KEY, REVIEW_DEFAULTS[MIN_POSITIVE_KEY]), read(MAX_NEGATIVE_KEY, REVIEW_DEFAULTS[MAX_NEGATIVE_KEY]), read(REVIEW_URL_KEY, ''),
    read(PLATFORM_KEY, REVIEW_DEFAULTS[PLATFORM_KEY]), read(LINK_BASE_KEY, ''),
  ]);
  return {
    minPositive: score(min, MIN_POSITIVE_KEY), maxNegative: score(max, MAX_NEGATIVE_KEY), reviewUrl: text(url),
    platform: (text(platform) || REVIEW_DEFAULTS[PLATFORM_KEY]).toUpperCase(), linkBase: text(linkBase).replace(/\/+$/, ''),
  };
}

module.exports = { MIN_POSITIVE_KEY, MAX_NEGATIVE_KEY, REVIEW_URL_KEY, PLATFORM_KEY, LINK_BASE_KEY, REVIEW_DEFAULTS, REVIEW_SETTINGS_SCHEMA, readReviewParams };
