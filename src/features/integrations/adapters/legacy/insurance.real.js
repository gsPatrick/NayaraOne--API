'use strict';

const { InsuranceAdapter } = require('../../providers/insurance/insurance.port');
const { PortoSeguroInsuranceAdapter, YelumInsuranceAdapter, JuntoSegurosInsuranceAdapter } = require('../../../procurement/adapters/InsuranceAdapter');
const { getDecryptedSetting, getSetting } = require('../../../settings/settings.service');
const AppError = require('../../../../utils/AppError');
const { wrapLegacy } = require('../legacyWrap');
const { STATUS, OPS, CAPABILITIES, CAPABILITIES_WEBHOOK, WEBHOOK, semConsultaPorChave } = require('./insurance.ops');

const configMissing = (nome) => AppError.badRequest(`O provedor de seguro ${nome} está selecionado, mas a credencial está incompleta — corrija a configuração antes de cotar, emitir ou enviar sinistro.`, 'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING');

/** Saúde sem rede: só confirma que a credencial abre no cofre. */
async function saudeCofre(ctx) {
  const t0 = Date.now();
  try { await ctx.secret('test-connection'); return { ok: true, latencyMs: Date.now() - t0, detail: 'Credencial lida do cofre; sem chamada de teste à seguradora.' }; } catch { return { ok: false, latencyMs: Date.now() - t0, detail: 'Credencial indisponível no cofre.' }; }
}

/** Porto Seguro: o segredo do cliente vem do cofre (SecretStore); o identificador e o ambiente, da configuração da empresa. Produção da Porto não está confirmada publicamente: mesmo host de homologação. */
async function makePorto(ctx, meta) {
  const tenant = meta && meta.tenant;
  const transaction = meta && meta.transaction;
  if (!tenant) throw configMissing('Porto Seguro');
  const segredo = await ctx.secret('dispatch');
  const [clientId, environment] = await Promise.all([
    getDecryptedSetting('procurement.porto_seguro_client_id', tenant, transaction, null),
    getSetting('procurement.porto_seguro_environment', tenant, transaction, 'sandbox'),
  ]);
  if (!clientId) throw configMissing('Porto Seguro');
  const baseUrl = environment === 'production' ? 'https://portoapi.portoseguro.com.br' : 'https://portoapi-hml.portoseguro.com.br';
  return new PortoSeguroInsuranceAdapter({ clientId, clientSecret: segredo.value.reveal(), baseUrl, authBaseUrl: baseUrl, http: ctx.http });
}

/** Yelum: a chave de API vem do cofre; o ambiente, da configuração da empresa. */
async function makeYelum(ctx, meta) {
  const tenant = meta && meta.tenant;
  const transaction = meta && meta.transaction;
  if (!tenant) throw configMissing('Yelum');
  const segredo = await ctx.secret('dispatch');
  const environment = await getSetting('procurement.yelum_environment', tenant, transaction, 'sandbox');
  const baseUrl = environment === 'production' ? 'https://integracao.grupohdiseguros.com.br' : 'https://integracao-tst.grupohdiseguros.com.br';
  return new YelumInsuranceAdapter({ apiKey: segredo.value.reveal(), baseUrl, http: ctx.http });
}

/** O adapter da seguradora real é criado na primeira operação (precisa do segredo do cofre e da configuração da empresa), com o contrato do port. Nenhuma das duas consulta pela chave (`semConsultaPorChave`): o envio incerto vai à revisão humana. */
const real = (className, code, make, hosts) => wrapLegacy({
  Port: InsuranceAdapter, className, code, capabilities: CAPABILITIES_WEBHOOK, makeLegacy: make, mapper: STATUS, ops: OPS, idempotentOps: ['propose'], lookups: { findByIdempotencyKey: semConsultaPorChave }, health: saudeCofre, hosts, ...WEBHOOK,
});

const InsurancePortoContractAdapter = real('InsurancePortoContractAdapter', 'insurance-porto-seguro', makePorto, ['portoapi.portoseguro.com.br', 'portoapi-hml.portoseguro.com.br']);
const InsuranceYelumContractAdapter = real('InsuranceYelumContractAdapter', 'insurance-yelum', makeYelum, ['integracao.grupohdiseguros.com.br', 'integracao-tst.grupohdiseguros.com.br']);

/** Junto Seguros: o objeto antigo sempre recusa (não há documentação técnica pública sem parceria de corretora). O contrato do port só o registra; toda operação devolve o erro de sempre. */
const InsuranceJuntoContractAdapter = wrapLegacy({
  Port: InsuranceAdapter, className: 'InsuranceJuntoContractAdapter', code: 'insurance-junto-seguros', capabilities: CAPABILITIES, mapper: STATUS, ops: OPS, idempotentOps: [],
  makeLegacy: () => new JuntoSegurosInsuranceAdapter(),
});

module.exports = { InsurancePortoContractAdapter, InsuranceYelumContractAdapter, InsuranceJuntoContractAdapter };
