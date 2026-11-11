'use strict';

// M9-D038 — pacote da NAY Jurídica: política, fronteira (escopo e seis proibições), marca de rascunho e tools de leitura.
const policy = require('./juridica.policy');
const { JURIDICA_SETTING_DEFAULTS, JURIDICA_SETTINGS_SCHEMA } = require('./juridica.settings');
const { validityAnswer } = require('./juridica.resolvers');
const { decorateDraft } = require('./juridica.output');
const { legalNay } = require('./juridica.toolServices');
const TOOL_DEFINITIONS = require('./tools');
const { registerAgentScope } = require('../scope');
const { registerJuridicaHooks, compareInstruction } = require('./juridica.hooks');

const KEY = {
  DECIDIR_VALIDADE: 'ia.nay_juridica.proibicao.decidir_validade',
  APROVAR_OU_ASSINAR: 'ia.nay_juridica.proibicao.aprovar_ou_assinar',
  ENVIAR_PARA_ASSINATURA: 'ia.nay_juridica.proibicao.enviar_para_assinatura',
  ALTERAR_VERSAO_ASSINADA: 'ia.nay_juridica.proibicao.alterar_versao_assinada',
  AFIRMAR_PRAZO_DEFINITIVO: 'ia.nay_juridica.proibicao.afirmar_prazo_definitivo',
  PARECER_FINAL: 'ia.nay_juridica.proibicao.parecer_final',
};

function registerNayJuridica() {
  registerJuridicaHooks(); // Fechamento M5 (§11): comparação de vistorias pedida pelo servidor
  registerAgentScope({
    code: policy.CODE,
    outOfScopeMessage: policy.OUT_OF_SCOPE_MESSAGE,
    scopeTermsKey: 'ia.nay_juridica.termos_escopo',
    scopeTermsDefault: JURIDICA_SETTING_DEFAULTS['ia.nay_juridica.termos_escopo'],
    prohibitions: policy.PROHIBITIONS.map((p) => ({
      ...p, key: KEY[p.code], defaultTerms: JURIDICA_SETTING_DEFAULTS[KEY[p.code]], ...(p.code === 'DECIDIR_VALIDADE' ? { respond: validityAnswer } : {}),
    })),
    decorate: decorateDraft,
  });
}

module.exports = { ...policy, JURIDICA_SETTING_DEFAULTS, JURIDICA_SETTINGS_SCHEMA, TOOL_DEFINITIONS, legalNay, registerNayJuridica, compareInstruction };
