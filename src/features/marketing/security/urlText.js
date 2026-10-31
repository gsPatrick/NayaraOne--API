'use strict';

const { validateExternalUrl } = require('./validateExternalUrl');
const { REASONS, staticReasons } = require('./urlRules');
const { readUrlConfig, DEFAULT_TLDS } = require('./url.settings');
const { mktUrlNotAllowed } = require('../marketing.errors');

/**
 * URLs escritas num texto (template, legenda, corpo, conteúdo). O texto termina a URL em espaço, aspas, parêntese ou colchete; pontuação final não faz parte dela.
 * Reconhece, nesta ordem (M9-D433, reabertura M-1): (1) qualquer esquema seguido de "/" ou "\" (https://, ftp://, file://, https:/x, https:\\x); (2) esquemas de código
 * sem barra (javascript:, data:, vbscript:, blob:, about:); (3) esquema relativo (//host e \\host); (4) www.; (5) domínio solto cuja terminação está em
 * `marketing.url.tlds_reconhecidos` ("evil.com/login"). Endereço de e-mail (com @) não é URL.
 */
const TAIL = '[^\\s<>"\'`)\\]}]';
const SCHEME_SLASH = new RegExp(`\\b[a-z][a-z0-9+.-]{1,19}:[/\\\\]${TAIL}*`, 'gi');
const CODE_SCHEME = new RegExp(`\\b(?:javascript|data|vbscript|blob|about):${TAIL}+`, 'gi');
const SCHEME_RELATIVE = new RegExp(`(?<![\\w:/\\\\.@-])(?:\\/\\/|\\\\\\\\)[a-z0-9]${TAIL}*`, 'gi');
const WWW = new RegExp(`(?<![\\w@./:\\\\-])www\\.${TAIL}+`, 'gi');
const TRAILING = /[.,;:!?]+$/;
const PLAIN_HTTP = /^https?:\/\/[^/\\]/i;

const bareDomain = (tlds) => new RegExp(`(?<![\\w@./:\\\\-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${tlds.join('|')})(?![a-z0-9-])(?:[/:?#]${TAIL}*)?`, 'gi');

function extractUrls(text, config = {}) {
  if (typeof text !== 'string') return [];
  const tlds = Array.isArray(config.tlds) && config.tlds.length > 0 ? config.tlds : DEFAULT_TLDS;
  let rest = text;
  const found = [];
  for (const re of [SCHEME_SLASH, CODE_SCHEME, SCHEME_RELATIVE, WWW, bareDomain(tlds)]) {
    rest = rest.replace(re, (match) => { found.push(match.replace(TRAILING, '')); return ' '.repeat(match.length); }); // o trecho achado sai do texto: os padrões seguintes não o contam de novo
  }
  return [...new Set(found.filter(Boolean))];
}

/** Motivos de uma "URL" que não é http(s)://host bem formada: esquema proibido, mal formada ou sem esquema. Estáticos, sem rede. */
function malformedReasons(url, config) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  const name = scheme ? scheme[1].toLowerCase() : null;
  if (name && name !== 'http' && name !== 'https') return [REASONS.FORBIDDEN_SCHEME];
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:/i, '').replace(/^[\\/]+/, '');
  const inner = staticReasons(`https://${rest}`, config).reasons.filter((r) => r !== REASONS.HTTPS_ONLY);
  return [name ? REASONS.MALFORMED : REASONS.HTTPS_ONLY, ...inner];
}

/** Valida cada URL do texto; devolve [{ url, reasons }] só das reprovadas. */
async function findDisallowedUrls(text, ctx = {}) {
  const config = ctx.config || await readUrlConfig(ctx.tenant, ctx.transaction);
  const bad = [];
  for (const url of extractUrls(text, config)) {
    if (!PLAIN_HTTP.test(url)) {
      bad.push({ url, reasons: malformedReasons(url, config) });
      continue;
    }
    const out = await validateExternalUrl(url, { ...ctx, config });
    if (!out.ok) bad.push({ url, reasons: out.reasons });
  }
  return bad;
}

/** Lança 422 MKT_URL_NOT_ALLOWED se qualquer URL do texto for reprovada (template e conteúdo usam a mesma regra do link rastreável). */
async function assertUrlsAllowed(text, ctx) {
  const bad = await findDisallowedUrls(text, ctx);
  if (bad.length > 0) throw mktUrlNotAllowed({ urls: bad });
  return true;
}

module.exports = { extractUrls, findDisallowedUrls, assertUrlsAllowed };
