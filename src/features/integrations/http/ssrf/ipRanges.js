'use strict';

const net = require('node:net');

/**
 * Faixas de IP que uma busca de URL de terceiro nunca pode alcançar (M9-D245 3.1 item 3): loopback, privados, link-local
 * (inclui os metadados da nuvem, 169.254.169.254), CGNAT, multicast, 0.0.0.0/8 e as faixas reservadas e de documentação.
 */
const V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
  // Metadados de nuvem fora das faixas acima (R3-M3): Azure (WireServer 168.63.129.16). Os de AWS, GCP, Oracle e Alibaba já caem em link-local, 192.0.0.0/24 e CGNAT.
  ['168.63.129.16', 32],
];
const V6 = [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  // Metadados da AWS em IPv6 (fd00:ec2::254): está dentro de fc00::/7 (rede própria liberável), por isso entra aqui como faixa que NUNCA se libera.
  ['fd00:ec2::', 32],
];
// Faixas de rede PRÓPRIA (RFC 1918 e ULA): só uma exceção explícita da empresa para um host nomeado as libera (M9-D244, parâmetro integration.egress.private_hosts).
const PRIVADAS_V4 = new Set(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
const PRIVADAS_V6 = new Set(['fc00::/7']);

const bloqueios = new net.BlockList();
const semRedePropria = new net.BlockList();
V4.forEach(([base, bits]) => { bloqueios.addSubnet(base, bits, 'ipv4'); if (!PRIVADAS_V4.has(`${base}/${bits}`)) semRedePropria.addSubnet(base, bits, 'ipv4'); });
V6.forEach(([base, bits]) => { bloqueios.addSubnet(base, bits, 'ipv6'); if (!PRIVADAS_V6.has(`${base}/${bits}`)) semRedePropria.addSubnet(base, bits, 'ipv6'); });

/** IPv6 "mapeado" (::ffff:a.b.c.d ou ::ffff:7f00:1) -> o IPv4 de dentro, ou null. */
function embeddedV4(ip) {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16); const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * true se o IP (texto) está numa faixa proibida; texto que não é IP também conta como proibido (falha fechada). `allowPrivate` libera só as redes
 * privadas (10/8, 172.16/12, 192.168/16, fc00::/7): loopback, metadados da nuvem, link-local, multicast e reservadas ficam bloqueados sempre.
 */
function isBlockedIp(ip, { allowPrivate = false } = {}) {
  const lista = allowPrivate ? semRedePropria : bloqueios;
  const familia = net.isIP(ip);
  if (!familia) return true;
  if (familia === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return lista.check(v4, 'ipv4');
    return lista.check(ip, 'ipv6');
  }
  return lista.check(ip, 'ipv4');
}

module.exports = { isBlockedIp, embeddedV4 };
