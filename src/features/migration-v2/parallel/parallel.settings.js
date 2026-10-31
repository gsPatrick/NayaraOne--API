'use strict';

/**
 * Parâmetros da comparação paralela (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv):
 *  - migracao.paralelo.intervalo_min (P9-EF-067): intervalo entre duas comparações de uma janela, em minutos (padrão 60). É o padrão de uma janela criada sem `intervalMin`.
 *  - migracao.paralelo.fuso: fuso (IANA) em que as datas da janela sem deslocamento e o "mesmo dia civil" da regra DATE são lidos (padrão America/Sao_Paulo).
 *  - migracao.paralelo.timeout_min: minutos até uma execução RUNNING sem fim (processo caído) ser dada como FAILED e liberar a janela (padrão 30).
 */
const KEYS = Object.freeze({ INTERVAL_MIN: 'migracao.paralelo.intervalo_min', TIMEZONE: 'migracao.paralelo.fuso', TIMEOUT_MIN: 'migracao.paralelo.timeout_min' });

const PARALLEL_SETTING_DEFAULTS = Object.freeze({ [KEYS.INTERVAL_MIN]: 60, [KEYS.TIMEZONE]: 'America/Sao_Paulo', [KEYS.TIMEOUT_MIN]: 30 });

function validateTimezone(key, value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(value).trim() }).format(new Date());
  } catch (err) {
    const { govError } = require('../../core-governance/governance.errors');
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser um fuso horário válido (por exemplo America/Sao_Paulo).`, { key, value });
  }
}

const PARALLEL_SETTINGS_SCHEMA = {
  [KEYS.INTERVAL_MIN]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.TIMEZONE]: { type: 'string', validate: validateTimezone },
  [KEYS.TIMEOUT_MIN]: { type: 'integer', min: 1, max: 1440 },
};

module.exports = { KEYS, PARALLEL_SETTING_DEFAULTS, PARALLEL_SETTINGS_SCHEMA };
