'use strict';

const net = require('node:net');
const AppError = require('../../../utils/AppError');
const { parseList } = require('./sdkPolicy');
const { isBlockedIp } = require('./ssrf/ipRanges');
const { isMetadataName } = require('./metadataNames');

const CODE = /^[a-z][a-z0-9_-]{1,47}$/;
const NOME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const MAX_HOSTS = 20;

/** null quando o host (nome ou IP exato) pode ser liberado como rede própria; senão o motivo. Curinga, esquema, porta e caminho nunca; loopback e metadados nunca. */
function privateHostProblem(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h || h.length > 253) return 'vazio ou longo demais';
  if (net.isIP(h)) return isBlockedIp(h, { allowPrivate: true }) ? 'faixa que nunca pode ser liberada (loopback, metadados da nuvem, link-local ou reservada)' : null;
  if (!NOME.test(h)) return 'use só o nome do host (sem curinga, esquema, porta ou caminho)';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'localhost nunca pode ser liberado';
  if (isMetadataName(h)) return 'nome de metadados da nuvem ou de serviço interno do orquestrador nunca pode ser liberado';
  const ultimo = h.split('.').pop();
  if (/^[0-9]+$/.test(ultimo) || /^0x[0-9a-f]*$/.test(ultimo)) return 'forma numérica de endereço não é aceita: use o IP completo ou o nome';
  return null;
}

/** "storage-s3:minio.empresa.lan,10.0.0.5;outro:host.lan" -> { codigo: [hosts exatos] }; null se o formato estiver errado ou algum host for proibido. */
function parsePrivateHosts(texto) {
  const out = {};
  for (const bloco of String(texto).split(';').map((b) => b.trim()).filter(Boolean)) {
    const i = bloco.indexOf(':');
    if (i < 1) return null;
    const codigo = bloco.slice(0, i).trim().toLowerCase();
    const hosts = parseList(bloco.slice(i + 1)).map((h) => h.toLowerCase());
    if (!CODE.test(codigo) || !hosts.length || hosts.some((h) => privateHostProblem(h))) return null;
    out[codigo] = [...new Set([...(out[codigo] || []), ...hosts])];
    if (out[codigo].length > MAX_HOSTS) return null;
  }
  return Object.keys(out).length ? out : null;
}

/** Exceção de rede própria (M9-D244, reabertura N7): hosts exatos, por fornecedor, que a empresa libera para destino em rede privada. Vazio = nenhuma exceção. */
const PRIVATE_HOSTS_SETTINGS_SCHEMA = Object.freeze({
  'integration.egress.private_hosts': {
    type: 'string',
    validate: (key, value) => {
      if (String(value).trim() !== '' && !parsePrivateHosts(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser fornecedor:host1,host2;outro:host3, com nomes ou IPs exatos de rede própria (sem curinga, porta, caminho, loopback nem metadados da nuvem; até ${MAX_HOSTS} por fornecedor).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
});

module.exports = { PRIVATE_HOSTS_SETTINGS_SCHEMA, parsePrivateHosts, privateHostProblem };
