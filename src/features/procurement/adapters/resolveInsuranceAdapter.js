'use strict';

const { getSetting, getDecryptedSetting } = require('../../settings/settings.service');
const AppError = require('../../../utils/AppError');
const {
  SandboxInsuranceAdapter,
  PortoSeguroInsuranceAdapter,
  YelumInsuranceAdapter,
} = require('./InsuranceAdapter');

// Mesmo padrão exato de resolveBankAdapter/resolveSignatureAdapter: fallback seguro pra
// SandboxInsuranceAdapter sempre que o provider real não tiver credencial completa configurada
// — ausência de configuração NUNCA quebra o fluxo de negócio.
//
// "junto_seguros" é um enum válido no settings (a opção aparece no front, documentada como
// "pendente de parceria"), mas NUNCA resolve pra um adapter real — JuntoSegurosInsuranceAdapter
// lança sempre que instanciado (ver InsuranceAdapter.js) porque não há documentação técnica
// pública confirmada pra escrever a integração de verdade. Até lá, selecionar "junto_seguros"
// no painel cai no Sandbox, igual a não ter configurado nada.
//
// REVISÃO MARCO 7 (19/10/2026, B6/B7) — mesmo padrão de resolveBankAdapter (B5 de 18/10):
//   - provedor real com credencial incompleta FALHA FECHADO (antes caía em silêncio no sandbox e
//     a apólice "emitida" ficava gravada com o nome do provedor real — B7);
//   - provedor sem integração (ex.: junto_seguros) também falha fechado;
//   - sandbox é proibido com DEPLOY_ENVIRONMENT=production (B6). O comentário acima descreve o
//     comportamento ANTIGO e fica só como histórico.
function providerConfigMissing(label) {
  return AppError.badRequest(
    `O provedor de seguro ${label} está selecionado, mas a credencial está incompleta — corrija a configuração antes de cotar, emitir ou enviar sinistro.`,
    'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING'
  );
}

function assertSandboxAllowed() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') {
    throw AppError.conflict(
      'O provedor de seguro sandbox (simulação) não pode ser usado em produção.',
      'INSURANCE_SANDBOX_FORBIDDEN_IN_PRODUCTION'
    );
  }
}

async function resolveInsuranceAdapter(tenant, transaction) {
  const provider = await getSetting('procurement.insurance_provider', tenant, transaction, 'sandbox');

  if (provider === 'porto_seguro') {
    const [clientId, clientSecret, environment] = await Promise.all([
      getDecryptedSetting('procurement.porto_seguro_client_id', tenant, transaction, null),
      getDecryptedSetting('procurement.porto_seguro_client_secret', tenant, transaction, null),
      getSetting('procurement.porto_seguro_environment', tenant, transaction, 'sandbox'),
    ]);
    if (clientId && clientSecret) {
      // Produção não confirmada publicamente (ver InsuranceAdapter.js) — mesmo host de
      // homologação usado como fallback até confirmação real.
      const baseUrl = environment === 'production'
        ? 'https://portoapi.portoseguro.com.br'
        : 'https://portoapi-hml.portoseguro.com.br';
      return new PortoSeguroInsuranceAdapter({ clientId, clientSecret, baseUrl, authBaseUrl: baseUrl });
    }
    throw providerConfigMissing('Porto Seguro');
  }

  if (provider === 'yelum') {
    const [apiKey, environment] = await Promise.all([
      getDecryptedSetting('procurement.yelum_api_key', tenant, transaction, null),
      getSetting('procurement.yelum_environment', tenant, transaction, 'sandbox'),
    ]);
    if (apiKey) {
      const baseUrl = environment === 'production'
        ? 'https://integracao.grupohdiseguros.com.br'
        : 'https://integracao-tst.grupohdiseguros.com.br';
      return new YelumInsuranceAdapter({ apiKey, baseUrl });
    }
    throw providerConfigMissing('Yelum');
  }

  if (provider !== 'sandbox') {
    throw AppError.badRequest(
      `O provedor de seguro "${provider}" está selecionado, mas não tem integração disponível — selecione o sandbox (homologação) ou um provedor com credencial configurada.`,
      'PROCUREMENT_INSURANCE_PROVIDER_UNAVAILABLE'
    );
  }
  assertSandboxAllowed();
  return new SandboxInsuranceAdapter();
}

module.exports = { resolveInsuranceAdapter, assertSandboxAllowed };
