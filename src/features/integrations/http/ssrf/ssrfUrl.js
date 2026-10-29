'use strict';

const { blocked } = require('./ssrfErrors');

const AUTORIDADE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const OCTETO_CANONICO = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_CANONICO = new RegExp(`^${OCTETO_CANONICO}(?:\\.${OCTETO_CANONICO}){3}$`);
const PARECE_NUMERO = /^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+))*\.?$/i;

/** Pedaços do texto ORIGINAL da URL (antes de o parser normalizar o host): esquema, credenciais, host e porta. */
function splitAuthority(url) {
  const m = AUTORIDADE.exec(String(url).trim());
  if (!m) return null;
  let auth = m[2];
  const arroba = auth.lastIndexOf('@');
  const credenciais = arroba > -1;
  if (credenciais) auth = auth.slice(arroba + 1);
  let host = auth; let port = '';
  if (auth.startsWith('[')) {
    const fim = auth.indexOf(']');
    host = auth.slice(0, fim + 1); port = auth.slice(fim + 1).replace(/^:/, '');
  } else if (auth.includes(':')) {
    const i = auth.lastIndexOf(':'); host = auth.slice(0, i); port = auth.slice(i + 1);
  }
  return { scheme: m[1].toLowerCase(), credenciais, host, port };
}

/**
 * Análise estrita da URL de terceiro (M9-D245 3.1 itens 1 e 2): esquema permitido, sem credenciais embutidas, porta na lista,
 * host que não seja IPv6 literal nem número em forma alternativa (inteiro decimal, octal, hexadecimal, IPv4 abreviado) e
 * sem rótulo punycode (xn--), salvo se o host consta explicitamente na lista do fluxo. Devolve { url: URL, hostname }.
 */
function parseStrictUrl(texto, { allowedSchemes, allowedPorts, allowedHosts = [] }) {
  const partes = splitAuthority(texto);
  if (!partes) throw blocked('URL_INVALID');
  if (!allowedSchemes.includes(partes.scheme)) throw blocked('SCHEME', null);
  if (partes.credenciais) throw blocked('CREDENTIALS');
  let url;
  try { url = new URL(String(texto).trim()); } catch { throw blocked('URL_INVALID'); }
  const hostname = url.hostname.toLowerCase();
  if (partes.host.startsWith('[') || hostname.startsWith('[')) throw blocked('IPV6_LITERAL', hostname);
  const portaTexto = partes.port === '' ? '443' : partes.port;
  if (!/^\d+$/.test(portaTexto) || !allowedPorts.includes(Number(portaTexto))) throw blocked('PORT', hostname);
  const bruto = partes.host.toLowerCase();
  if (PARECE_NUMERO.test(bruto) && !IPV4_CANONICO.test(bruto)) throw blocked('NUMERIC_HOST_FORM', hostname);
  if (bruto.split('.').some((r) => r.startsWith('xn--')) && !allowedHosts.includes(hostname)) throw blocked('PUNYCODE', hostname);
  return { url, hostname };
}

module.exports = { parseStrictUrl, splitAuthority };
