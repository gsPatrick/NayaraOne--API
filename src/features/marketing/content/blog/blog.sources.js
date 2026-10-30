'use strict';

/**
 * M9-D427 regra 5 — fontes do blog. Cada item de `fontes[]` é um texto "URL | AAAA-MM-DD" (URL da fonte e data de acesso), porque o corpo
 * da requisição só aceita lista de textos (DI-D427-5). Fonte válida: URL http(s) com domínio permitido e data real. O domínio vale por igualdade ou
 * por subdomínio (ibge.gov.br aceita servicodados.ibge.gov.br; gov.br aceita www.gov.br).
 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(text) {
  const m = DATE_RE.exec(text);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]);
}

const hostAllowed = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/** { index (1-based), raw, url, host, accessedAt, problem } — `problem` é null quando a fonte é válida e permitida. */
function parseSource(raw, index, allowedDomains) {
  const text = String(raw === undefined || raw === null ? '' : raw);
  const [urlPart, datePart] = text.split('|').map((p) => p.trim());
  const entry = { index, raw: text.slice(0, 200), url: null, host: null, accessedAt: datePart || null, problem: null };
  let url = null;
  try { url = new URL(urlPart); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol)) return { ...entry, problem: 'URL_INVALID' };
  entry.url = url.toString();
  entry.host = url.hostname.toLowerCase();
  if (!datePart || !validDate(datePart)) return { ...entry, problem: 'ACCESS_DATE_INVALID' };
  if (!hostAllowed(entry.host, allowedDomains)) return { ...entry, problem: 'DOMAIN_NOT_ALLOWED' };
  return entry;
}

const parseSources = (list, allowedDomains) => (Array.isArray(list) ? list : []).map((raw, i) => parseSource(raw, i + 1, allowedDomains));

module.exports = { parseSources, parseSource, hostAllowed };
