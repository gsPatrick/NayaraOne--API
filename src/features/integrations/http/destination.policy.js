'use strict';

const net = require('node:net');
const AppError = require('../../../utils/AppError');
const { LOCAL_HOSTS, hostOf } = require('./egressPolicy');
const { isBlockedIp } = require('./ssrf/ipRanges');
const { resolveAndValidate, defaultLookup } = require('./ssrf/ssrfResolve');
const { isInternalOrNumericName } = require('./egressHostRules');

/**
 * Destino público (M9-D245, reabertura G2/M3): vale para TODA chamada do cliente HTTP único, em qualquer modo de saída (inclusive `log`) e para
 * qualquer host, venha ele do código ou da configuração. IP de rede privada, loopback, link-local (metadados da nuvem) ou nome interno é recusado antes
 * de qualquer conexão; o nome é resolvido UMA vez e a conexão usa o endereço validado (DNS fixado, sem nova resolução). A única exceção é o
 * localhost em teste e em SANDBOX, a mesma de `assertSecureScheme`.
 */
const privateDestination = (host) => new AppError('Destino não permitido para esta integração.', 502, 'INTEGRATION_EGRESS_BLOCKED', { host, reason: 'PRIVATE_DESTINATION' });

/** Resolvedor padrão: o DNS do sistema; em teste nenhum (os mocks de fetch usam nomes fictícios), e quem prova o DNS injeta o seu. */
const defaultResolver = () => (process.env.NODE_ENV === 'test' ? null : defaultLookup);

const isLocalException = (host, { environment, nodeEnv = process.env.NODE_ENV } = {}) => LOCAL_HOSTS.includes(host) && (nodeEnv === 'test' || environment === 'SANDBOX');

/**
 * Confere o destino de uma URL. Devolve { host, local, pin } onde `pin` é { address, family } (ou null quando não há resolvedor ou o host é literal/local).
 * Lança 502 INTEGRATION_EGRESS_BLOCKED (reason PRIVATE_DESTINATION) para IP proibido, nome interno ou nome que resolve para endereço proibido.
 */
async function resolveDestination(url, { environment, resolver, nodeEnv, privateHosts = [] } = {}) {
  const host = hostOf(url);
  if (!host) throw privateDestination(null);
  if (isLocalException(host, { environment, nodeEnv })) return { host, local: true, pin: null };
  if (privateHosts.includes(host)) return resolvePrivateHost(host, resolver); // exceção explícita da empresa (integration.egress.private_hosts)
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw privateDestination(host);
    return { host, local: false, pin: null };
  }
  if (isInternalOrNumericName(host)) throw privateDestination(host);
  if (!resolver) return { host, local: false, pin: null };
  try {
    const [alvo] = await resolveAndValidate(host, { resolver });
    return { host, local: false, pin: { address: alvo.address, family: alvo.family } };
  } catch { throw privateDestination(host); }
}

/** Host de rede própria liberado pela empresa: aceita endereço privado (RFC 1918 e ULA), nunca loopback, metadados ou reservadas; a conexão fica presa ao endereço validado. */
async function resolvePrivateHost(host, resolver) {
  if (!resolver && !net.isIP(host)) return { host, local: false, pin: null }; // sem resolvedor (teste) não há consulta; o IP literal é conferido sempre
  try {
    const [alvo] = await resolveAndValidate(host, { resolver, allowPrivate: true });
    return { host, local: false, pin: { address: alvo.address, family: alvo.family } };
  } catch { throw privateDestination(host); }
}

module.exports = { resolveDestination, defaultResolver, privateDestination, isLocalException };
