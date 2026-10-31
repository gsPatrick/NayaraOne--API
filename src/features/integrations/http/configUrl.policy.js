'use strict';

const net = require('node:net');
const AppError = require('../../../utils/AppError');
const { assertSecureScheme, hostOf, matchHost } = require('./egressPolicy');
const { isBlockedIp } = require('./ssrf/ipRanges');
const { isInternalOrNumericName } = require('./egressHostRules');
const { isLocalException } = require('./destination.policy');

/**
 * URL base vinda da configuração de uma conexão (M9-D245, reabertura G2): `config_json.baseUrl` de Clicksign e ZapSign (e o equivalente de qualquer
 * fornecedor). Vale a mesma política da IA: https, sem credencial na URL, host público (nada de IP privado, metadados da nuvem ou nome interno) e host dentro
 * da lista fechada do fornecedor (os hosts que o adaptador declara mais o parâmetro `integration.egress.provider_hosts`). A lista de saída da conexão
 * (`policy.egressHosts`) NÃO amplia esta lista: o administrador da empresa não escolhe para onde vai o token do fornecedor.
 */
const invalid = (problema, host = null) => AppError.unprocessable('O endereço do fornecedor não é permitido.', 'INTEGRATION_CONFIG_INVALID', { problemas: [problema], host });

function assertConfiguredBaseUrl({ baseUrl, allowedHosts = [], environment, nodeEnv = process.env.NODE_ENV }) {
  let u;
  try { u = assertSecureScheme(baseUrl, { environment, nodeEnv }); } catch { throw invalid('baseUrl: use um endereço https'); }
  if (u.username || u.password) throw invalid('baseUrl: o endereço não pode levar usuário nem senha');
  if (u.hash) throw invalid('baseUrl: o endereço não pode ter fragmento');
  const host = hostOf(baseUrl);
  if (isLocalException(host, { environment, nodeEnv })) return u;
  if (net.isIP(host) ? isBlockedIp(host) : isInternalOrNumericName(host)) throw invalid('baseUrl: o endereço aponta para rede interna', host);
  if (!allowedHosts.some((p) => matchHost(p, host))) throw invalid('baseUrl: o host não está na lista permitida deste fornecedor', host);
  return u;
}

module.exports = { assertConfiguredBaseUrl };
