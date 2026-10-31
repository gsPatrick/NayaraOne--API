'use strict';

const { mktError } = require('../marketing.errors');

/**
 * M9-D433 — parâmetros da validação de URL externa (Caderno §14). Dicionário fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread) + getSetting.
 *  - dominios_permitidos (MKT-P056): domínios extras aceitos (portais e redes homologados), separados por vírgula; "nenhum" = só os da empresa. Os domínios da
 *    empresa (URL base do site e domínios próprios do blog) valem sempre.
 *  - encurtadores: encurtadores públicos proibidos (lista do livro: "encurtadores públicos proibidos").
 *  - max_saltos: quantos redirecionamentos são seguidos e verificados (livro: 3). max_comprimento: tamanho máximo da URL (livro: 2048).
 *  - tlds_reconhecidos: terminações (com, br, io...) que fazem uma palavra solta do texto valer como endereço ("evil.com/login" sem https://); a conferência de URL no texto pega
 *    também www., //, esquemas malformados e esquemas proibidos sem depender desta lista.
 *  - verificar_destino: liga a verificação de DNS e de redirecionamento (critérios 6 e 7); desligar é decisão do administrador. timeout_s: espera de cada consulta.
 */
const ALLOWED_KEY = 'marketing.url.dominios_permitidos';
const SHORTENERS_KEY = 'marketing.url.encurtadores';
const MAX_HOPS_KEY = 'marketing.url.max_saltos';
const MAX_LENGTH_KEY = 'marketing.url.max_comprimento';
const VERIFY_KEY = 'marketing.url.verificar_destino';
const TIMEOUT_KEY = 'marketing.url.timeout_s';
const TLDS_KEY = 'marketing.url.tlds_reconhecidos';
const NONE = 'nenhum';

const URL_SETTING_DEFAULTS = Object.freeze({
  [ALLOWED_KEY]: NONE,
  [SHORTENERS_KEY]: 'bit.ly, tinyurl.com, t.co, goo.gl, is.gd, ow.ly, buff.ly, rebrand.ly, cutt.ly, shorturl.at, tiny.cc',
  [MAX_HOPS_KEY]: 3,
  [MAX_LENGTH_KEY]: 2048,
  [VERIFY_KEY]: true,
  [TIMEOUT_KEY]: 5,
  [TLDS_KEY]: 'com, net, org, br, io, co, info, biz, app, dev, xyz, online, site, top, club, shop, store, link, click, me, tv, cc, us, uk, de, pt, ar, ru, cn, tk, ml, ga, cf, gq, ly, to, gl, ws, pw, live, work, page, cloud, tech, pro, vip, icu, buzz, fun, one, ink, wang',
});

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const getSetting = (...args) => require('../../settings/settings.service').getSetting(...args);

/** "A.com, b.com" -> ['a.com','b.com'] (minúsculas, sem vazios nem repetidos; "nenhum" = vazio). */
function parseDomainList(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (!raw || raw.toLowerCase() === NONE) return [];
  return [...new Set(raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

const validateDomains = (allowNone) => (key, value) => {
  const list = parseDomainList(value);
  const bad = list.filter((d) => !DOMAIN_RE.test(d));
  if ((!allowNone && list.length === 0) || bad.length > 0) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: 'domínios separados por vírgula (ex.: portal.com.br, rede.com)', invalidos: bad });
  }
};

const TLD_RE = /^[a-z]{2,24}$/;
const parseTlds = (text) => [...new Set(String(text === undefined || text === null ? '' : text).split(',').map((t) => t.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))];
const DEFAULT_TLDS = Object.freeze(parseTlds(URL_SETTING_DEFAULTS[TLDS_KEY]));

const validateTlds = (key, value) => {
  const list = parseTlds(value);
  if (list.length === 0 || !list.every((t) => TLD_RE.test(t))) {
    throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, esperado: 'terminações separadas por vírgula, só letras (ex.: com, br, io)' });
  }
};

const URL_SETTINGS_SCHEMA = {
  [TLDS_KEY]: { type: 'string', validate: validateTlds },
  [ALLOWED_KEY]: { type: 'string', validate: validateDomains(true) },
  [SHORTENERS_KEY]: { type: 'string', validate: validateDomains(false) },
  [MAX_HOPS_KEY]: { type: 'integer', min: 0, max: 10 },
  [MAX_LENGTH_KEY]: { type: 'integer', min: 64, max: 8192 },
  [VERIFY_KEY]: { type: 'boolean' },
  [TIMEOUT_KEY]: { type: 'integer', min: 1, max: 60 },
};

const validDomains = (list) => list.filter((d) => DOMAIN_RE.test(d));
const intOr = (value, fallback, min) => (Number.isInteger(Number(value)) && Number(value) >= min ? Number(value) : fallback);

/** Os domínios da empresa: a URL base do site (SEO) e os domínios próprios do blog. Fonte única, sem repetir parâmetro. */
async function companyDomains(tenant, transaction) {
  const { BASE_URL_KEY, SEO_SETTING_DEFAULTS } = require('../publications/seo/seo.settings');
  const { OWN_DOMAINS_KEY, BLOG_SETTING_DEFAULTS, parseDomains } = require('../content/blog/blog.settings');
  const [base, own] = await Promise.all([
    getSetting(BASE_URL_KEY, tenant, transaction, SEO_SETTING_DEFAULTS[BASE_URL_KEY]),
    getSetting(OWN_DOMAINS_KEY, tenant, transaction, BLOG_SETTING_DEFAULTS[OWN_DOMAINS_KEY]),
  ]);
  let host = null;
  try { host = new URL(String(base)).hostname.toLowerCase(); } catch (err) { host = null; }
  const bare = host && host.startsWith('www.') ? host.slice(4) : null; // o site em www.x.com.br também vale em x.com.br
  return [...(host ? [host] : []), ...(bare ? [bare] : []), ...validDomains(parseDomains(own))];
}

/** Configuração da empresa já saneada (valor estranho volta ao padrão). */
async function readUrlConfig(tenant, transaction) {
  const [allowed, shorteners, hops, length, verify, timeout, company, tlds] = await Promise.all([
    getSetting(ALLOWED_KEY, tenant, transaction, URL_SETTING_DEFAULTS[ALLOWED_KEY]),
    getSetting(SHORTENERS_KEY, tenant, transaction, URL_SETTING_DEFAULTS[SHORTENERS_KEY]),
    getSetting(MAX_HOPS_KEY, tenant, transaction, URL_SETTING_DEFAULTS[MAX_HOPS_KEY]),
    getSetting(MAX_LENGTH_KEY, tenant, transaction, URL_SETTING_DEFAULTS[MAX_LENGTH_KEY]),
    getSetting(VERIFY_KEY, tenant, transaction, URL_SETTING_DEFAULTS[VERIFY_KEY]),
    getSetting(TIMEOUT_KEY, tenant, transaction, URL_SETTING_DEFAULTS[TIMEOUT_KEY]),
    companyDomains(tenant, transaction),
    getSetting(TLDS_KEY, tenant, transaction, URL_SETTING_DEFAULTS[TLDS_KEY]),
  ]);
  const tldList = parseTlds(tlds).filter((t) => TLD_RE.test(t));
  const shortList = validDomains(parseDomainList(shorteners));
  return {
    allowedDomains: [...new Set([...company, ...validDomains(parseDomainList(allowed))])],
    shorteners: shortList.length ? shortList : validDomains(parseDomainList(URL_SETTING_DEFAULTS[SHORTENERS_KEY])),
    maxHops: intOr(hops, URL_SETTING_DEFAULTS[MAX_HOPS_KEY], 0),
    maxLength: intOr(length, URL_SETTING_DEFAULTS[MAX_LENGTH_KEY], 64),
    verifyDestination: verify !== false && verify !== 'false',
    timeoutMs: intOr(timeout, URL_SETTING_DEFAULTS[TIMEOUT_KEY], 1) * 1000,
    tlds: tldList.length ? tldList : DEFAULT_TLDS,
  };
}

module.exports = {
  ALLOWED_KEY, SHORTENERS_KEY, MAX_HOPS_KEY, MAX_LENGTH_KEY, VERIFY_KEY, TIMEOUT_KEY, TLDS_KEY, DEFAULT_TLDS, URL_SETTING_DEFAULTS, URL_SETTINGS_SCHEMA, parseDomainList, readUrlConfig,
};
