'use strict';

const { isValidZone } = require('./timezone.convert');

/**
 * Parâmetros do fuso da migração (M9-D908 §3.2; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv):
 *  - migracao.fuso_origem (P9-EF-075): fuso (IANA) dos timestamps do sistema antigo que vêm sem fuso (padrão America/Sao_Paulo).
 *  - migracao.fuso.ambiguo (P9-EF-076): o que fazer com um horário local que ocorre duas vezes: FIRST_OCCURRENCE, SECOND_OCCURRENCE ou QUARANTINE (padrão FIRST_OCCURRENCE).
 *  - migracao.fuso.amostra_por_entidade: registros por entidade conferidos ponto a ponto com datas de borda no ensaio (padrão 1000).
 */
const KEYS = Object.freeze({ ORIGIN_ZONE: 'migracao.fuso_origem', AMBIGUOUS: 'migracao.fuso.ambiguo', SAMPLE: 'migracao.fuso.amostra_por_entidade' });
const AMBIGUOUS_RULES = Object.freeze(['FIRST_OCCURRENCE', 'SECOND_OCCURRENCE', 'QUARANTINE']);

const TIMEZONE_SETTING_DEFAULTS = Object.freeze({ [KEYS.ORIGIN_ZONE]: 'America/Sao_Paulo', [KEYS.AMBIGUOUS]: 'FIRST_OCCURRENCE', [KEYS.SAMPLE]: 1000 });

function validateZone(key, value) {
  if (!isValidZone(String(value).trim())) {
    const { govError } = require('../../core-governance/governance.errors');
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser um fuso horário válido (por exemplo America/Sao_Paulo).`, { key, value });
  }
}

const TIMEZONE_SETTINGS_SCHEMA = {
  [KEYS.ORIGIN_ZONE]: { type: 'string', validate: validateZone },
  [KEYS.AMBIGUOUS]: { type: 'string', enum: [...AMBIGUOUS_RULES] },
  [KEYS.SAMPLE]: { type: 'integer', min: 1, max: 1000000 },
};

module.exports = { KEYS, AMBIGUOUS_RULES, TIMEZONE_SETTING_DEFAULTS, TIMEZONE_SETTINGS_SCHEMA };
