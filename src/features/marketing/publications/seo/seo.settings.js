'use strict';

const { mktError } = require('../../marketing.errors');

/**
 * M9-D427 — parâmetros do SEO do site (Marketing). Mesmo padrão do projeto: dicionário fail-closed em SETTINGS_SCHEMA (settings.service.js
 * faz o spread de SEO_SETTINGS_SCHEMA) + getSetting(chave, tenant, transaction, padrão). Padrões de Maturacao/demandas/parametros.csv
 * (MKT-P046, P047, P048); a base das URLs absolutas (canonical) e o tempo de cache por URL são decisões de implementação (DI-D427-1 e DI-D427-9).
 */
const POLICY_SOLD_KEY = 'marketing.seo.politica_vendido';
const DAYS_SOLD_KEY = 'marketing.seo.dias_selo_vendido';
const DAYS_REMOVED_KEY = 'marketing.seo.dias_removido';
const CACHE_SECONDS_KEY = 'marketing.seo.cache_s';

const POLICY_SELO = 'SELO_E_REDIRECT';
const POLICY_IMMEDIATE = 'REDIRECT_IMEDIATO';
const SOLD_POLICIES = Object.freeze([POLICY_SELO, POLICY_IMMEDIATE]);
const { BASE_URL_KEY, NO_BASE_URL } = require('../../marketing.domains');

const SEO_SETTING_DEFAULTS = Object.freeze({
  [POLICY_SOLD_KEY]: POLICY_SELO,
  [DAYS_SOLD_KEY]: 30,
  [DAYS_REMOVED_KEY]: 0,
  [BASE_URL_KEY]: NO_BASE_URL,
  [CACHE_SECONDS_KEY]: 60,
});

// settings.service.js importa este arquivo (SETTINGS_SCHEMA): a leitura é carregada na hora do uso, para não fechar um ciclo.
const getSetting = (...args) => require('../../../settings/settings.service').getSetting(...args);

function validatePolicy(key, value) {
  if (!SOLD_POLICIES.includes(String(value).trim())) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: SOLD_POLICIES.join(' ou ') });
  }
}

function validateBaseUrl(key, value) {
  const text = String(value).trim();
  if (text === NO_BASE_URL) return;
  let url = null;
  try { url = new URL(text); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: `endereço https do site sem parâmetros (ex.: https://www.suaempresa.com.br) ou "${NO_BASE_URL}"` });
  }
}

const SEO_SETTINGS_SCHEMA = {
  [POLICY_SOLD_KEY]: { type: 'string', validate: validatePolicy },
  [DAYS_SOLD_KEY]: { type: 'integer', min: 0, max: 3650 },
  [DAYS_REMOVED_KEY]: { type: 'integer', min: 0, max: 3650 },
  [BASE_URL_KEY]: { type: 'string', validate: validateBaseUrl },
  [CACHE_SECONDS_KEY]: { type: 'integer', min: 0, max: 86400 },
};

const intOr = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);

/** Os quatro parâmetros do ciclo da página, já saneados (valor fora do dicionário volta ao padrão: nunca decide por valor estranho). */
async function readSeoConfig(tenant, transaction) {
  const [policy, soldDays, removedDays, baseUrl, cacheSeconds] = await Promise.all([
    getSetting(POLICY_SOLD_KEY, tenant, transaction, SEO_SETTING_DEFAULTS[POLICY_SOLD_KEY]),
    getSetting(DAYS_SOLD_KEY, tenant, transaction, SEO_SETTING_DEFAULTS[DAYS_SOLD_KEY]),
    getSetting(DAYS_REMOVED_KEY, tenant, transaction, SEO_SETTING_DEFAULTS[DAYS_REMOVED_KEY]),
    getSetting(BASE_URL_KEY, tenant, transaction, SEO_SETTING_DEFAULTS[BASE_URL_KEY]),
    getSetting(CACHE_SECONDS_KEY, tenant, transaction, SEO_SETTING_DEFAULTS[CACHE_SECONDS_KEY]),
  ]);
  const base = String(baseUrl).trim();
  return {
    soldPolicy: SOLD_POLICIES.includes(String(policy).trim()) ? String(policy).trim() : POLICY_SELO,
    soldDays: intOr(soldDays, SEO_SETTING_DEFAULTS[DAYS_SOLD_KEY]),
    removedDays: intOr(removedDays, SEO_SETTING_DEFAULTS[DAYS_REMOVED_KEY]),
    baseUrl: base === NO_BASE_URL || !base ? null : base.replace(/\/+$/, ''),
    cacheSeconds: intOr(cacheSeconds, SEO_SETTING_DEFAULTS[CACHE_SECONDS_KEY]),
  };
}

module.exports = {
  POLICY_SOLD_KEY, DAYS_SOLD_KEY, DAYS_REMOVED_KEY, BASE_URL_KEY, CACHE_SECONDS_KEY, POLICY_SELO, POLICY_IMMEDIATE, SOLD_POLICIES, SEO_SETTING_DEFAULTS, SEO_SETTINGS_SCHEMA, readSeoConfig,
};
