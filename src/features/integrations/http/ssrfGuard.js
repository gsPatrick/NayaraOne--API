'use strict';

const crypto = require('node:crypto');
const { readSsrfParams } = require('./ssrf/ssrf.params');
const { getFlow } = require('./ssrf/ssrfFlows');
const { parseStrictUrl } = require('./ssrf/ssrfUrl');
const { resolveAndValidate } = require('./ssrf/ssrfResolve');
const { fetchPinned } = require('./ssrf/ssrfTransport');
const { deliverToQuarantine } = require('./ssrf/quarantinePort');
const { auditBlock } = require('./ssrf/ssrf.audit');
const { matchHost } = require('./egressPolicy');
const { blocked, fetchTimeout } = require('./ssrf/ssrfErrors');

const emTeste = () => process.env.NODE_ENV === 'test';

/** Tipos aceitos = os do fluxo (se ele declarou) limitados pelos do parâmetro da empresa; aceita 'image/*'. */
function effectiveTypes(flow, params) {
  const aceita = (tipo) => params.contentTypes.some((p) => (p.endsWith('/*') ? tipo.startsWith(p.slice(0, -1)) : tipo === p));
  return flow.contentTypes.length ? flow.contentTypes.filter(aceita) : params.contentTypes;
}

async function buscar(url, flow, params, opts) {
  const hosts = [...flow.hosts, ...(params.flowHosts[flow.code] || [])];
  const tipos = effectiveTypes(flow, params);
  const inicio = Date.now();
  let atual = url;
  for (let salto = 0; salto <= params.maxRedirects; salto += 1) {
    const { url: u, hostname } = parseStrictUrl(atual, { allowedSchemes: params.allowedSchemes, allowedPorts: params.allowedPorts, allowedHosts: hosts });
    if (!hosts.some((p) => matchHost(p, hostname))) throw blocked('NOT_ALLOWED_HOST', hostname);
    const [alvo] = await resolveAndValidate(hostname, { resolver: opts.resolver });
    const restante = params.timeoutMs - (Date.now() - inicio);
    if (restante <= 0) throw fetchTimeout();
    const r = await fetchPinned({
      url: u, hostname, address: alvo.address, family: alvo.family, timeoutMs: restante, maxBytes: params.maxBytes, contentTypes: tipos,
      tls: emTeste() ? opts._tls : undefined, connect: emTeste() ? opts._connect : undefined,
    });
    if (!Object.prototype.hasOwnProperty.call(r, 'redirect')) return { r, hostname };
    if (!r.redirect || salto >= params.maxRedirects) throw blocked('REDIRECT', hostname);
    atual = new URL(r.redirect, u).href;
  }
  throw blocked('REDIRECT');
}

/**
 * fetchExternalUrl — a ÚNICA forma de buscar uma URL que veio de terceiro (M9-D245): link de foto de portal, callback de
 * fornecedor, mídia de mensagem, importação por URL. Só https, sem credenciais nem IP em forma estranha, só hosts que o FLUXO
 * permite (a allowlist de saída dos fornecedores, M9-D244, não vale aqui), DNS resolvido uma vez com cada IP validado e
 * conexão presa ao IP validado, redirecionamento recusado (padrão), tamanho e tempo cortados, tipo de conteúdo conferido.
 * O conteúdo vai para a QUARENTENA e volta marcado QUARANTINED: nunca é executado nem interpretado como HTML.
 * `opts`: flow (obrigatório, ver ssrfFlows), tenant ({groupId, companyId}) e transaction (parâmetros da empresa e auditoria),
 * connection (para o erro registrado), resolver (DNS, para teste). Devolve { buffer, contentType, bytes, sha256, host, quarantine }.
 */
async function fetchExternalUrl(url, opts = {}) {
  const flow = getFlow(opts.flow);
  try {
    if (!flow) throw blocked('FLOW_UNKNOWN');
    const lidos = await readSsrfParams(opts.tenant, opts.transaction);
    const params = emTeste() && opts._params ? { ...lidos, ...opts._params } : lidos;
    const { r, hostname } = await buscar(url, flow, params, opts);
    const sha256 = crypto.createHash('sha256').update(r.buffer).digest('hex');
    const quarantine = await deliverToQuarantine({ buffer: r.buffer, contentType: r.contentType, sha256, origin: { flow: flow.code, host: hostname } });
    return { buffer: r.buffer, contentType: r.contentType, bytes: r.buffer.length, sha256, host: hostname, quarantine };
  } catch (err) {
    if (err.code === 'INTEGRATION_SSRF_BLOCKED') await auditBlock(err, { flow: opts.flow, tenant: opts.tenant, transaction: opts.transaction, connection: opts.connection });
    throw err;
  }
}

module.exports = { fetchExternalUrl };
