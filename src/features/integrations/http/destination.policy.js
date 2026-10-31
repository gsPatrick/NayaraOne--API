'use strict';

const net = require('node:net');
const AppError = require('../../../utils/AppError');
const { LOCAL_HOSTS, hostOf } = require('./egressPolicy');
const { isBlockedIp } = require('./ssrf/ipRanges');
const { resolveAndValidate, defaultLookup } = require('./ssrf/ssrfResolve');
const { isInternalOrNumericName } = require('./egressHostRules');
const { isMetadataName } = require('./metadataNames');

/**
 * Destino público (M9-D245, reabertura G2/M3): vale para TODA chamada do cliente HTTP único, em qualquer modo de saída (inclusive `log`) e para
 * qualquer host, venha ele do código ou da configuração. IP de rede privada, loopback, link-local (metadados da nuvem) ou nome interno é recusado antes
 * de qualquer conexão; o nome é resolvido UMA vez e a conexão usa o endereço validado (DNS fixado, sem nova resolução). A única exceção é o
 * localhost com NODE_ENV=test no servidor (nunca pelo campo `environment` da conexão), a mesma de `assertSecureScheme`.
 */
const privateDestination = (host, reason = 'PRIVATE_DESTINATION') => new AppError('Destino não permitido para esta integração.', 502, 'INTEGRATION_EGRESS_BLOCKED', { host, reason });

/** Porta padrão de saída das integrações (o livro: 443); quem muda é o parâmetro integration.ssrf.allowed_ports, só da plataforma. */
const DEFAULT_PORTS = Object.freeze([443]);

/** Porta efetiva da URL (a omitida vale 443 em https). A porta fora da lista é recusada ANTES de qualquer conexão, com a mesma resposta dos demais bloqueios: não há oráculo de porta aberta ou fechada. */
const portOf = (url) => { try { const u = new URL(String(url)); return Number(u.port || (u.protocol === 'http:' ? 80 : 443)); } catch { return null; } };

/** Resolvedor padrão: o DNS do sistema; em teste nenhum (os mocks de fetch usam nomes fictícios), e quem prova o DNS injeta o seu. */
const defaultResolver = () => (process.env.NODE_ENV === 'test' ? null : defaultLookup);

const isLocalException = (host, { nodeEnv = process.env.NODE_ENV } = {}) => LOCAL_HOSTS.includes(host) && nodeEnv === 'test';

/**
 * Confere o destino de uma URL. Devolve { host, local, pin } onde `pin` é { address, family } (ou null quando não há resolvedor ou o host é literal/local).
 * Lança 502 INTEGRATION_EGRESS_BLOCKED (reason PRIVATE_DESTINATION) para IP proibido, nome interno ou nome que resolve para endereço proibido.
 */
async function resolveDestination(url, { environment, resolver, nodeEnv, privateHosts = [], allowedPorts = DEFAULT_PORTS } = {}) {
  const host = hostOf(url);
  if (!host) throw privateDestination(null);
  if (isLocalException(host, { environment, nodeEnv })) return { host, local: true, pin: null };
  if (isMetadataName(host)) throw privateDestination(host); // metadados e serviços internos de nuvem: nunca, nem como exceção da plataforma (R3-M3)
  if (privateHosts.includes(host)) return resolvePrivateHost(host, resolver); // exceção explícita da plataforma (integration.egress.private_hosts); a rede própria escolhe a sua porta (ex.: MinIO 9000)
  if (!allowedPorts.includes(portOf(url))) throw privateDestination(host, 'PORT_NOT_ALLOWED');
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
