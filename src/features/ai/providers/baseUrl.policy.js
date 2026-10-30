'use strict';

const { hostOf, matchHost, assertSecureScheme } = require('../../integrations/http/egressPolicy');
const { AiProviderError } = require('./providers.errors');

const FREE_ENVS = ['test', 'development'];

/**
 * baseUrl do provider (DI-IA-LEVE-4). O modo de saída `log` só registra e deixa passar; então a lista não pode depender dele: fora de
 * dev e teste, um `config_json.baseUrl` só vale se for HTTPS e o host for o do próprio fornecedor ou constar em `policy.egressHosts`
 * (a lista de saída que o administrador mantém na conexão). Qualquer outro endereço é recusado antes de a chave sair do servidor.
 */
function assertBaseUrlAllowed({ baseUrl, defaultBaseUrl, egressHosts = [], providerCode, nodeEnv = process.env.NODE_ENV }) {
  if (FREE_ENVS.includes(nodeEnv)) return;
  const refuse = () => new AiProviderError('VALIDATION', { providerCode, upstreamCode: 'BASEURL_NOT_ALLOWED', code: 'AI_PROVIDER_BASEURL_NOT_ALLOWED', message: 'O endereço do provedor não está na lista de saída permitida.' });
  try { assertSecureScheme(baseUrl, { nodeEnv }); } catch { throw refuse(); }
  const host = hostOf(baseUrl);
  const allowed = [hostOf(defaultBaseUrl), ...egressHosts];
  if (!host || !allowed.some((p) => matchHost(p, host))) throw refuse();
}

module.exports = { assertBaseUrlAllowed };
