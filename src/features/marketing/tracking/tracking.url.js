'use strict';

const net = require('node:net');
const { MAX_URL_LENGTH } = require('./tracking.catalog');
const { urlNotAllowed } = require('./tracking.errors');

/**
 * M9-D431 — validação da URL de destino do link. A validação completa (allowlist de domínio da empresa, DNS, redirecionamentos)
 * é da M9-D433 (`validateExternalUrl`), que a registra aqui com registerExternalUrlValidator. Até lá o link passa pela base abaixo,
 * que já recusa o que é inseguro em qualquer caso: só https, sem credencial, sem IP literal nem rede local, sem encurtador público e
 * até 2048 caracteres. Falha: 422 MKT_URL_NOT_ALLOWED.
 */
const SHORTENERS = Object.freeze(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc']);
const LOCAL_SUFFIXES = Object.freeze(['.local', '.internal', '.localhost', '.lan', '.home.arpa']);

function baseValidator(rawUrl) {
  const reasons = [];
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return ['URL_VAZIA'];
  if (rawUrl.length > MAX_URL_LENGTH) reasons.push('URL_LONGA_DEMAIS');
  let url;
  try { url = new URL(rawUrl.trim()); } catch (err) { return [...reasons, 'URL_INVALIDA']; }
  if (url.protocol !== 'https:') reasons.push('SO_HTTPS');
  if (url.username || url.password) reasons.push('CREDENCIAL_NA_URL');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host) || host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) reasons.push('HOST_LOCAL_OU_IP');
  if (SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`))) reasons.push('ENCURTADOR_PROIBIDO');
  return reasons;
}

let customValidator = null;

function registerExternalUrlValidator(fn) {
  if (typeof fn !== 'function') throw new TypeError('O validador de URL deve ser uma função.');
  customValidator = fn;
}

function resetExternalUrlValidator() {
  customValidator = null;
}

/** Devolve a URL normalizada ou lança 422 MKT_URL_NOT_ALLOWED. O validador da D433 (se registrado) roda DEPOIS da base. */
async function assertAllowedUrl(rawUrl, ctx) {
  const reasons = baseValidator(rawUrl);
  if (reasons.length > 0) throw urlNotAllowed({ reasons });
  if (customValidator) {
    const out = await customValidator(rawUrl.trim(), ctx);
    if (out && out.ok === false) throw urlNotAllowed({ reasons: out.reasons || ['REPROVADA'] });
  }
  return new URL(rawUrl.trim()).toString();
}

/** URL final do redirecionamento: o destino com as UTMs (as que o destino já traz não são sobrescritas). */
function withUtms(targetUrl, link) {
  const url = new URL(targetUrl);
  const pairs = { utm_source: link.utm_source, utm_medium: link.utm_medium, utm_campaign: link.utm_campaign, utm_content: link.utm_content, utm_term: link.utm_term };
  for (const [key, value] of Object.entries(pairs)) if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
  return url.toString();
}

module.exports = { SHORTENERS, baseValidator, registerExternalUrlValidator, resetExternalUrlValidator, assertAllowedUrl, withUtms };
