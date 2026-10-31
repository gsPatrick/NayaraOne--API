'use strict';

const { validateExternalUrl } = require('./validateExternalUrl');
const { REASONS, staticReasons } = require('./urlRules');
const { readUrlConfig } = require('./url.settings');
const { mktUrlNotAllowed } = require('../marketing.errors');
const { extractUrls, extractCandidates, stripUrls } = require('./urlText.extract');

const PLAIN_HTTP = /^https?:\/\/[^/\\]/i;
const BARE_FORM = /^(?![a-z][a-z0-9+.-]*:|[/\\])/i; // sem esquema e sem barra na frente: domínio solto, www. ou IP nu

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
  const urls = extractCandidates(text, config).filter((c) => c.kind === 'HOSTILE').map((c) => c.url);
  // Teto por passo (M9-D433, parâmetro marketing.url.max_urls_verificadas): a rede só é consultada para as primeiras URLs; texto com mais que isso é recusado inteiro, sem consulta a mais.
  if (urls.length > config.maxUrls) return [{ url: `${urls.length} URLs`, reasons: [REASONS.TOO_MANY_URLS], limit: config.maxUrls }];
  for (const url of urls) {
    if (!PLAIN_HTTP.test(url)) {
      const reasons = malformedReasons(url, config);
      // O domínio da própria empresa (ou da allowlist) escrito sem https:// ("Acesse www.nayara.com.br") não é risco: só o esquema falta (DI-D433-8).
      if (BARE_FORM.test(url) && reasons.length === 1 && reasons[0] === REASONS.HTTPS_ONLY) continue;
      bad.push({ url, reasons });
      continue;
    }
    const out = await validateExternalUrl(url, { ...ctx, config });
    if (!out.ok) bad.push({ url, reasons: out.reasons });
  }
  return bad;
}

/** Candidatos de baixo risco (abreviação, nome de arquivo, número) que não bloqueiam: o texto segue, mas vai à aprovação humana com finding explícito. */
async function findReviewUrls(text, ctx = {}) {
  const config = ctx.config || await readUrlConfig(ctx.tenant, ctx.transaction);
  return extractCandidates(text, config).filter((c) => c.kind === 'REVIEW').map((c) => c.url);
}

/** Lança 422 MKT_URL_NOT_ALLOWED se qualquer URL do texto for reprovada (template e conteúdo usam a mesma regra do link rastreável). */
async function assertUrlsAllowed(text, ctx) {
  const bad = await findDisallowedUrls(text, ctx);
  if (bad.length > 0) throw mktUrlNotAllowed({ urls: bad });
  return true;
}

module.exports = { extractUrls, extractCandidates, stripUrls, findDisallowedUrls, findReviewUrls, assertUrlsAllowed };
