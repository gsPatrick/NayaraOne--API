'use strict';

const AppError = require('../../../../utils/AppError');
const { hostPatternProblem } = require('../../http/egressHostRules');

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,30}$/;

/** Problemas da configuração de um destino S3 (vazio = válida): o host nasce de texto livre da conexão, então é conferido como NOME de host público (M9-D245). */
function s3ConfigProblems(config) {
  const c = config || {};
  const problemas = [];
  const hostProblema = typeof c.endpoint === 'string' && !c.endpoint.includes('*') ? hostPatternProblem(c.endpoint) : 'informe o endpoint como nome de host';
  if (hostProblema) problemas.push(`endpoint: ${hostProblema}`);
  if (typeof c.bucket !== 'string' || !BUCKET.test(c.bucket) || c.bucket.includes('..')) problemas.push('bucket: nome inválido (letras minúsculas, números, "." e "-", de 3 a 63)');
  if (c.region !== undefined && (typeof c.region !== 'string' || !REGION.test(c.region))) problemas.push('region: nome de região inválido');
  return problemas;
}

/** Destino do objeto conforme o estilo (path-style ou virtual-hosted), depois de conferir a configuração. */
function s3Target(config, key) {
  const problemas = s3ConfigProblems(config);
  if (problemas.length) throw AppError.unprocessable('A configuração do armazenamento não é permitida.', 'INTEGRATION_CONFIG_INVALID', { problemas });
  const c = config;
  const style = c.pathStyle === true;
  return { host: style ? c.endpoint : `${c.bucket}.${c.endpoint}`, path: style ? `/${c.bucket}/${key}` : `/${key}`, region: c.region || 'us-east-1' };
}

module.exports = { s3ConfigProblems, s3Target };
