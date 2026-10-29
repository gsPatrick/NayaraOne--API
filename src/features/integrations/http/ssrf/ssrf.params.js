'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { parseList } = require('../sdkPolicy');
const { parseFlowHosts } = require('./ssrf.settings');

/** Padrões do parametros.csv, usados quando a empresa não configurou (ou não há empresa, como nos adaptadores antigos). */
const PADROES = Object.freeze({
  allowedSchemes: ['https'], maxRedirects: 0, maxBytes: 26214400, timeoutMs: 10000, allowedPorts: [443],
  contentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'],
});

const inteiro = (v, padrao, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : padrao);

/** Parâmetros da busca de URL de terceiro (M9-D245). Sem `tenant`, vale o padrão do livro. */
async function readSsrfParams(tenant, transaction) {
  const [schemes, redirects, bytes, allow, timeout, ports, types] = await Promise.all([
    getSetting('integration.ssrf.allowed_schemes', tenant, transaction, null),
    getSetting('integration.ssrf.max_redirects', tenant, transaction, PADROES.maxRedirects),
    getSetting('integration.ssrf.max_bytes', tenant, transaction, PADROES.maxBytes),
    getSetting('integration.ssrf.fetch_allowlist', tenant, transaction, null),
    getSetting('integration.ssrf.timeout_ms', tenant, transaction, PADROES.timeoutMs),
    getSetting('integration.ssrf.allowed_ports', tenant, transaction, null),
    getSetting('integration.ssrf.content_types', tenant, transaction, null),
  ]);
  const esquemas = parseList(schemes).map((s) => s.toLowerCase());
  const portas = parseList(ports).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  const tipos = parseList(types).map((t) => t.toLowerCase());
  return {
    allowedSchemes: esquemas.length ? esquemas : [...PADROES.allowedSchemes],
    maxRedirects: inteiro(redirects, PADROES.maxRedirects, 0, 5),
    maxBytes: inteiro(bytes, PADROES.maxBytes, 1024, 104857600),
    timeoutMs: inteiro(timeout, PADROES.timeoutMs, 1000, 60000),
    allowedPorts: portas.length ? portas : [...PADROES.allowedPorts],
    contentTypes: tipos.length ? tipos : [...PADROES.contentTypes],
    flowHosts: typeof allow === 'string' ? (parseFlowHosts(allow) || {}) : {},
  };
}

module.exports = { PADROES, readSsrfParams };
