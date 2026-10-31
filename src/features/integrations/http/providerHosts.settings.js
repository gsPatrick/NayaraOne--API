'use strict';

const AppError = require('../../../utils/AppError');
const { parseList } = require('./sdkPolicy');
const { hostPatternProblem } = require('./egressHostRules');

const CODE = /^[a-z][a-z0-9_-]{1,47}$/;

/** "signature-clicksign:app.x.com,sandbox.x.com;outro:api.y.com" -> { codigo: [hosts] }; null se o formato estiver errado ou algum host for inválido. */
function parseProviderHosts(texto) {
  const out = {};
  for (const bloco of String(texto).split(';').map((b) => b.trim()).filter(Boolean)) {
    const i = bloco.indexOf(':');
    if (i < 1) return null;
    const codigo = bloco.slice(0, i).trim().toLowerCase();
    const hosts = parseList(bloco.slice(i + 1)).map((h) => h.toLowerCase());
    if (!CODE.test(codigo) || !hosts.length || hosts.some((h) => hostPatternProblem(h))) return null;
    out[codigo] = [...new Set([...(out[codigo] || []), ...hosts])];
  }
  return Object.keys(out).length ? out : null;
}

/** Parâmetros dos hosts de cada fornecedor (M9-D245, reabertura G2): só o dicionário de SETTINGS_SCHEMA; a leitura está em providerHosts.params.js. */
const PROVIDER_HOSTS_SETTINGS_SCHEMA = Object.freeze({
  // Hosts a mais que cada fornecedor pode ter como endereço base, além dos que o adaptador declara. Nunca aceita IP nem nome interno.
  'integration.egress.provider_hosts': {
    type: 'string',
    validate: (key, value) => {
      if (String(value).trim() !== '' && !parseProviderHosts(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser fornecedor:host1,host2;outro:host3, com nomes de host públicos (sem IP, porta ou caminho).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
});

const PROVIDER_HOSTS_KEY = 'integration.egress.provider_hosts';
/** N1: esta chave decide para onde vai o token do fornecedor; só a equipe da plataforma (integration:platform) a altera, além de settings:update. */
const isProviderHostsKey = (key) => String(key) === PROVIDER_HOSTS_KEY;

module.exports = { PROVIDER_HOSTS_SETTINGS_SCHEMA, parseProviderHosts, isProviderHostsKey };
