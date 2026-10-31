'use strict';

const AppError = require('../../../utils/AppError');
const { assertConfiguredBaseUrl } = require('../http/configUrl.policy');
const { baseHostsOf } = require('../http/providerBaseHosts');
const { readProviderHosts } = require('../http/providerHosts.params');
const { readPrivateHosts } = require('../http/privateHosts.params');
const { s3ConfigProblems } = require('../providers/storage/storage.s3.target');


/**
 * Endereços na configuração da conexão (M9-D245, reabertura G2/M3), conferidos já na gravação (a execução confere de novo): `baseUrl` dos fornecedores que a usam
 * (mapa de hosts em providerBaseHosts.js; a IA tem a política própria) precisa ser https, de host público e da lista do fornecedor (hosts do adaptador mais o parâmetro
 * `integration.egress.provider_hosts`); o armazenamento S3 exige endpoint, bucket e região bem formados. 422 INTEGRATION_CONFIG_INVALID.
 */
async function validarEnderecosDaConfig(provider, configJson, ctx, transaction) {
  const config = configJson || {};
  if (provider.code === 'storage-s3') {
    const problemas = s3ConfigProblems(config, { privateHosts: await readPrivateHosts(provider.code, ctx, transaction) });
    if (problemas.length) throw AppError.unprocessable(`A configuração não confere com o formato do fornecedor: ${problemas.slice(0, 5).join('; ')}.`, 'INTEGRATION_CONFIG_INVALID', { problemas });
    return;
  }
  const doFornecedor = baseHostsOf(provider.code);
  if (!doFornecedor.length || config.baseUrl === undefined || config.baseUrl === null || config.baseUrl === '') return; // só quem usa a URL base (o mapa de hosts); os demais não a leem
  const hosts = [...doFornecedor, ...(await readProviderHosts(provider.code, ctx, transaction))];
  assertConfiguredBaseUrl({ baseUrl: String(config.baseUrl), allowedHosts: hosts, environment: ctx.environment });
}

module.exports = { validarEnderecosDaConfig };
