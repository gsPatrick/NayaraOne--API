'use strict';

/**
 * Parâmetros do registro de flags e configurações (M9-D870; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.flags.risco_padrao: risco de uma chave nova quando quem cria não informa (MEDIUM).
 *  - governanca.flags.risco_config_absorvida: risco das configurações da empresa absorvidas pelo registro (LOW).
 *  - governanca.flags.risco_interruptores_degradacao: risco dos cinco interruptores de degradação por custo (MEDIUM).
 *  - governanca.flags.valor_max_caracteres: tamanho máximo do valor de texto ou JSON de uma chave (2000).
 */
const F = 'governanca.flags.';
const KEYS = Object.freeze({
  defaultRisk: `${F}risco_padrao`, absorbedRisk: `${F}risco_config_absorvida`, switchRisk: `${F}risco_interruptores_degradacao`, valueMax: `${F}valor_max_caracteres`,
});
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const FLAGS_SETTING_DEFAULTS = Object.freeze({
  [KEYS.defaultRisk]: 'MEDIUM', [KEYS.absorbedRisk]: 'LOW', [KEYS.switchRisk]: 'MEDIUM', [KEYS.valueMax]: 2000,
});

const FLAGS_SETTINGS_SCHEMA = {
  [KEYS.defaultRisk]: { type: 'string', enum: RISK_LEVELS },
  [KEYS.absorbedRisk]: { type: 'string', enum: RISK_LEVELS },
  [KEYS.switchRisk]: { type: 'string', enum: RISK_LEVELS },
  [KEYS.valueMax]: { type: 'integer', min: 100, max: 100000 },
};

module.exports = { KEYS, RISK_LEVELS, FLAGS_SETTING_DEFAULTS, FLAGS_SETTINGS_SCHEMA };
