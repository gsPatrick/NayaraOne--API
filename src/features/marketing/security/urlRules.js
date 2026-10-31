'use strict';

const net = require('node:net');

/**
 * M9-D433 — critérios estáticos da URL externa (sem rede): 1 só https; 2 domínio na allowlist; 3 sem encurtador público; 4 sem credenciais; 5 sem IP literal nem
 * localhost/rede privada; 8 tamanho. Os critérios 6 e 7 (DNS e redirecionamento) são de validateExternalUrl. Cada motivo é um código estável.
 */
const REASONS = Object.freeze({
  EMPTY: 'URL_VAZIA', INVALID: 'URL_INVALIDA', TOO_LONG: 'URL_LONGA_DEMAIS', HTTPS_ONLY: 'SO_HTTPS', NOT_ALLOWLISTED: 'DOMINIO_FORA_DA_ALLOWLIST',
  SHORTENER: 'ENCURTADOR_PROIBIDO', CREDENTIALS: 'CREDENCIAL_NA_URL', LOCAL_OR_IP: 'HOST_LOCAL_OU_IP', PRIVATE_DNS: 'DNS_PARA_REDE_PRIVADA', DNS_FAILED: 'DNS_NAO_RESOLVE',
  REDIRECT_OUT: 'REDIRECIONAMENTO_FORA_DA_ALLOWLIST', MALFORMED: 'URL_MAL_FORMADA', FORBIDDEN_SCHEME: 'ESQUEMA_PROIBIDO', TOO_MANY_HOPS: 'REDIRECIONAMENTOS_DEMAIS', UNVERIFIABLE: 'DESTINO_NAO_VERIFICAVEL',
});
const LOCAL_SUFFIXES = Object.freeze(['.local', '.internal', '.localhost', '.lan', '.home.arpa']);

const matchesDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** O host (minúsculo) pertence a algum dos domínios (o próprio ou um subdomínio)? */
const inDomains = (host, domains) => domains.some((d) => matchesDomain(host, d));

/** { reasons[], url: URL|null, host } com os critérios estáticos aplicados à URL e à configuração { allowedDomains, shorteners, maxLength }. */
function staticReasons(rawUrl, config) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return { reasons: [REASONS.EMPTY], url: null, host: null };
  const reasons = [];
  if (rawUrl.trim().length > config.maxLength) reasons.push(REASONS.TOO_LONG);
  let url;
  try { url = new URL(rawUrl.trim()); } catch (err) { return { reasons: [...reasons, REASONS.INVALID], url: null, host: null }; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:') reasons.push(REASONS.HTTPS_ONLY);
  if (url.username || url.password) reasons.push(REASONS.CREDENTIALS);
  if (net.isIP(host) || host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) reasons.push(REASONS.LOCAL_OR_IP);
  else if (inDomains(host, config.shorteners)) reasons.push(REASONS.SHORTENER);
  else if (!inDomains(host, config.allowedDomains)) reasons.push(REASONS.NOT_ALLOWLISTED);
  return { reasons, url, host };
}

module.exports = { REASONS, matchesDomain, inDomains, staticReasons };
