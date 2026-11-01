'use strict';

const { mktError } = require('../marketing.errors');
const { BASE_URL_KEY, NO_BASE_URL, OWN_DOMAINS_KEY, NO_DOMAINS, parseDomains } = require('../marketing.domains');

/**
 * M9-D433 — parâmetros da validação de URL externa (Caderno §14). Dicionário fail-closed em SETTINGS_SCHEMA (settings.service.js faz o spread) + getSetting.
 *  - dominios_permitidos (MKT-P056): domínios extras aceitos (portais e redes homologados), separados por vírgula; "nenhum" = só os da empresa. Os domínios da
 *    empresa (URL base do site e domínios próprios do blog) valem sempre.
 *  - encurtadores: encurtadores públicos proibidos (lista do livro: "encurtadores públicos proibidos").
 *  - max_saltos: quantos redirecionamentos são seguidos e verificados (livro: 3). max_comprimento: tamanho máximo da URL (livro: 2048).
 *  - tlds_reconhecidos: terminações conhecidas (com, br, io...). Todo token com forma de domínio é conferido, com qualquer terminação; a lista só decide o que é
 *    abreviação ("Av.Paulista", "Sr.Silva": terminação FORA da lista) e nome de arquivo (extensão fora da lista), que não bloqueiam e vão à aprovação humana.
 *  - extensoes_arquivo: extensões de arquivo ("foto.jpg") que vão à aprovação humana em vez de bloquear. max_urls_verificadas: teto de URLs de um texto conferidas (DNS e
 *    redirecionamento) por passo; acima disso o texto é recusado (nenhuma consulta de rede a mais).
 *  - verificar_destino: liga a verificação de DNS e de redirecionamento (critérios 6 e 7); desligar é decisão do administrador. timeout_s: espera de cada consulta.
 */
const ALLOWED_KEY = 'marketing.url.dominios_permitidos';
const SHORTENERS_KEY = 'marketing.url.encurtadores';
const MAX_HOPS_KEY = 'marketing.url.max_saltos';
const MAX_LENGTH_KEY = 'marketing.url.max_comprimento';
const VERIFY_KEY = 'marketing.url.verificar_destino';
const TIMEOUT_KEY = 'marketing.url.timeout_s';
const TLDS_KEY = 'marketing.url.tlds_reconhecidos';
const MAX_URLS_KEY = 'marketing.url.max_urls_verificadas';
const FILE_EXT_KEY = 'marketing.url.extensoes_arquivo';
const NONE = 'nenhum';

const URL_SETTING_DEFAULTS = Object.freeze({
  [ALLOWED_KEY]: NONE,
  [SHORTENERS_KEY]: 'bit.ly, tinyurl.com, t.co, goo.gl, is.gd, ow.ly, buff.ly, rebrand.ly, cutt.ly, shorturl.at, tiny.cc, rb.gy, t.ly, s.id, v.gd, bit.do, lnkd.in, tr.ee, soo.gd, clck.ru, qr.net, 0rz.tw',
  [MAX_HOPS_KEY]: 3,
  [MAX_LENGTH_KEY]: 2048,
  [VERIFY_KEY]: true,
  [TIMEOUT_KEY]: 5,
  [MAX_URLS_KEY]: 20,
  [FILE_EXT_KEY]: 'jpg, jpeg, png, gif, webp, svg, pdf, doc, docx, xls, xlsx, ppt, pptx, csv, txt, rtf, html, htm, php, asp, aspx, mp4, mp3, wav, json, xml',
  [TLDS_KEY]: 'com, net, org, br, io, co, info, biz, app, dev, xyz, online, site, top, club, shop, store, link, click, me, tv, cc, us, uk, de, pt, ar, ru, cn, tk, ml, ga, cf, gq, ly, to, gl, ws, pw, live, work, page, cloud, tech, pro, vip, icu, buzz, fun, one, ink, wang, in, fr, es, it, ng, nl, ch, se, jp, kr, au, ca, mx, cl, pe, uy, eu, za, tr, ir, id, vn, sg, hk, tw, su, gov, edu, mil, zip, mov, ninja, sbs, cfd, rest, bond, museum, men, loan, win, bid, review, stream, download, cam, monster, quest, party, trade, date, science, accountant, racing, рф, भारत, বাংলা, ਭਾਰਤ, ભારત, భారత్, ಭಾರತ, ഭാരതം, ලංකා, ଭାରତ, संगठन, சிங்கப்பூர், भारतम्, भारोत, कॉम, नेट, ভারত',
});

/** Rótulos dos campos na tela (mesmos de marketingUrlGroups.js): a mensagem de erro diz o campo e o formato, nunca a chave técnica. */
const FIELD_LABELS = Object.freeze({
  [ALLOWED_KEY]: 'Domínios extras permitidos',
  [SHORTENERS_KEY]: 'Encurtadores públicos proibidos',
  [TLDS_KEY]: 'Terminações conhecidas de endereço',
  [FILE_EXT_KEY]: 'Extensões de arquivo que não bloqueiam o texto',
});
const invalidParam = (key, esperado, extra) => mktError(422, 'MKT_PARAM_INVALID', `${FIELD_LABELS[key] || 'Parâmetro'}: use ${esperado}.`, { key, esperado, ...extra });

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
    throw invalidParam(key, allowNone ? 'domínios separados por vírgula, como portal.com.br, rede.com (ou a palavra nenhum)' : 'pelo menos um domínio, separados por vírgula, como bit.ly, tinyurl.com', { invalidos: bad });
  }
};

const TLD_RE = /^(?:xn--[a-z0-9-]{2,59}|\p{L}[\p{L}\p{M}]{1,23})$/u;
const parseTlds = (text) => [...new Set(String(text === undefined || text === null ? '' : text).split(',').map((t) => t.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))];
const DEFAULT_TLDS = Object.freeze(parseTlds(URL_SETTING_DEFAULTS[TLDS_KEY]));

const validateTlds = (key, value) => {
  const list = parseTlds(value);
  if (list.length === 0 || !list.every((t) => TLD_RE.test(t))) {
    throw invalidParam(key, 'terminações separadas por vírgula, só letras, como com, br, io');
  }
};

const DEFAULT_SHORTENERS = Object.freeze(parseDomainList(URL_SETTING_DEFAULTS[SHORTENERS_KEY]));
const parseExtensions = parseTlds;
const DEFAULT_FILE_EXTENSIONS = Object.freeze(parseExtensions(URL_SETTING_DEFAULTS[FILE_EXT_KEY]));
const validateExtensions = (key, value) => {
  const list = parseExtensions(value);
  if (list.length === 0 || !list.every((t) => /^[a-z0-9]{1,10}$/.test(t))) {
    throw invalidParam(key, 'extensões separadas por vírgula, letras e números, como jpg, pdf');
  }
};

const URL_SETTINGS_SCHEMA = {
  [MAX_URLS_KEY]: { type: 'integer', min: 1, max: 200 },
  [FILE_EXT_KEY]: { type: 'string', validate: validateExtensions },
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
  const [base, own] = await Promise.all([
    getSetting(BASE_URL_KEY, tenant, transaction, NO_BASE_URL),
    getSetting(OWN_DOMAINS_KEY, tenant, transaction, NO_DOMAINS),
  ]);
  let host = null;
  try { host = new URL(String(base)).hostname.toLowerCase(); } catch (err) { host = null; }
  const bare = host && host.startsWith('www.') ? host.slice(4) : null; // o site em www.x.com.br também vale em x.com.br
  return [...(host ? [host] : []), ...(bare ? [bare] : []), ...validDomains(parseDomains(own))];
}

/** Configuração da empresa já saneada (valor estranho volta ao padrão). */
async function readUrlConfig(tenant, transaction) {
  const [allowed, shorteners, hops, length, verify, timeout, company, tlds, maxUrls, extensions] = await Promise.all([
    getSetting(ALLOWED_KEY, tenant, transaction, URL_SETTING_DEFAULTS[ALLOWED_KEY]),
    getSetting(SHORTENERS_KEY, tenant, transaction, URL_SETTING_DEFAULTS[SHORTENERS_KEY]),
    getSetting(MAX_HOPS_KEY, tenant, transaction, URL_SETTING_DEFAULTS[MAX_HOPS_KEY]),
    getSetting(MAX_LENGTH_KEY, tenant, transaction, URL_SETTING_DEFAULTS[MAX_LENGTH_KEY]),
    getSetting(VERIFY_KEY, tenant, transaction, URL_SETTING_DEFAULTS[VERIFY_KEY]),
    getSetting(TIMEOUT_KEY, tenant, transaction, URL_SETTING_DEFAULTS[TIMEOUT_KEY]),
    companyDomains(tenant, transaction),
    getSetting(TLDS_KEY, tenant, transaction, URL_SETTING_DEFAULTS[TLDS_KEY]),
    getSetting(MAX_URLS_KEY, tenant, transaction, URL_SETTING_DEFAULTS[MAX_URLS_KEY]),
    getSetting(FILE_EXT_KEY, tenant, transaction, URL_SETTING_DEFAULTS[FILE_EXT_KEY]),
  ]);
  const extList = parseExtensions(extensions).filter((t) => /^[a-z0-9]{1,10}$/.test(t));
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
    maxUrls: intOr(maxUrls, URL_SETTING_DEFAULTS[MAX_URLS_KEY], 1),
    fileExtensions: extList.length ? extList : DEFAULT_FILE_EXTENSIONS,
  };
}

module.exports = {
  ALLOWED_KEY, SHORTENERS_KEY, MAX_HOPS_KEY, MAX_LENGTH_KEY, VERIFY_KEY, TIMEOUT_KEY, TLDS_KEY, MAX_URLS_KEY, FILE_EXT_KEY, DEFAULT_TLDS, DEFAULT_FILE_EXTENSIONS, DEFAULT_SHORTENERS, URL_SETTING_DEFAULTS, URL_SETTINGS_SCHEMA, parseDomainList, readUrlConfig,
};
