'use strict';

const net = require('node:net');
const AppError = require('../../../../utils/AppError');
const { hostPatternProblem } = require('../../http/egressHostRules');
const { isMetadataName } = require('../../http/metadataNames');
const { isBlockedIp } = require('../../http/ssrf/ipRanges');

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,30}$/;

/** Problemas da configuração de um destino S3 (vazio = válida): o host nasce de texto livre da conexão, então é conferido como NOME de host público (M9-D245). */
function s3ConfigProblems(config, { privateHosts = [] } = {}) {
  const c = config || {};
  const problemas = [];
  // IPv6 literal (com ou sem colchetes) nunca vira URL válida do SDK de armazenamento (ERR_INVALID_URL na execução): recusa já na gravação, mesmo que liberado como rede própria.
  const ipv6 = typeof c.endpoint === 'string' && (net.isIPv6(c.endpoint.replace(/^\[|\]$/g, '')) || /[[\]:]/.test(c.endpoint));
  // rede própria liberada pela plataforma (integration.egress.private_hosts); metadados da nuvem e IP loopback/link-local/reservado nunca (R3-M3), mesmo que o valor gravado os traga
  const propria = !ipv6 && typeof c.endpoint === 'string' && privateHosts.includes(c.endpoint.toLowerCase()) && !isMetadataName(c.endpoint) && !(net.isIP(c.endpoint) && isBlockedIp(c.endpoint, { allowPrivate: true }));
  const hostProblema = ipv6 ? 'endereço IPv6 literal não é aceito: use o nome do host ou um IPv4' : propria ? null : (typeof c.endpoint === 'string' && !c.endpoint.includes('*') ? hostPatternProblem(c.endpoint) : 'informe o endpoint como nome de host');
  if (hostProblema) problemas.push(`endpoint: ${hostProblema}`);
  if (propria && c.pathStyle !== true) problemas.push('endpoint: o endereço de rede própria exige pathStyle (o nome do bucket não vira subdomínio)');
  if (typeof c.bucket !== 'string' || !BUCKET.test(c.bucket) || c.bucket.includes('..')) problemas.push('bucket: nome inválido (letras minúsculas, números, "." e "-", de 3 a 63)');
  if (c.region !== undefined && (typeof c.region !== 'string' || !REGION.test(c.region))) problemas.push('region: nome de região inválido');
  return problemas;
}

/** Destino do objeto conforme o estilo (path-style ou virtual-hosted), depois de conferir a configuração. */
function s3Target(config, key, { privateHosts = [] } = {}) {
  const problemas = s3ConfigProblems(config, { privateHosts });
  if (problemas.length) throw AppError.unprocessable('A configuração do armazenamento não é permitida.', 'INTEGRATION_CONFIG_INVALID', { problemas });
  const c = config;
  const style = c.pathStyle === true;
  return { host: style ? c.endpoint : `${c.bucket}.${c.endpoint}`, path: style ? `/${c.bucket}/${key}` : `/${key}`, region: c.region || 'us-east-1' };
}

module.exports = { s3ConfigProblems, s3Target };
