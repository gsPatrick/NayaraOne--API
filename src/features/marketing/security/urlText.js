'use strict';

const { validateExternalUrl } = require('./validateExternalUrl');
const { mktUrlNotAllowed } = require('../marketing.errors');

/** URLs http/https escritas num texto (template, legenda, corpo). O texto termina a URL em espaço, aspas, parêntese ou colchete; pontuação final não faz parte dela. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const TRAILING = /[.,;:!?]+$/;

function extractUrls(text) {
  if (typeof text !== 'string') return [];
  return [...new Set((text.match(URL_IN_TEXT) || []).map((u) => u.replace(TRAILING, '')))];
}

/** Valida cada URL do texto; devolve [{ url, reasons }] só das reprovadas. */
async function findDisallowedUrls(text, ctx) {
  const bad = [];
  for (const url of extractUrls(text)) {
    const out = await validateExternalUrl(url, ctx);
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
