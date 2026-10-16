'use strict';

const { getSetting, getDecryptedSetting } = require('../../settings/settings.service');
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
  }

  return new SandboxInsuranceAdapter();
}

module.exports = { resolveInsuranceAdapter };
