'use strict';

const { govError } = require('../../governance.errors');

/**
 * Parâmetros do catálogo de consumidores e da deprecação (M9-D841; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.api.aviso_dias: quantos dias antes do desligamento o evento api.consumer.deprecation_due é publicado (padrão 30).
 *  - governanca.api.deprecacao.consumidor_ativo_dias: janela em que o consumidor conta como "usando" um alvo (padrão 30).
 *  - governanca.api.deprecacao.job_hora: hora (America/Sao_Paulo) da avaliação diária das deprecações (padrão 7).
 *  - governanca.api.deprecacao.cache_segundos: por quanto tempo cada processo guarda as deprecações e consumidores da empresa (padrão 30; 1 a 3600).
 *  - governanca.api.consumidor.uso_intervalo_minutos: no máximo uma gravação de uso por consumidor e alvo neste intervalo (padrão 60).
 *  - governanca.api.consumidor.app_web_chave: valor do cabeçalho X-Client-App do front web (padrão nayara-web, o da semente).
 */
const AVISO_DIAS_KEY = 'governanca.api.aviso_dias';
const ATIVO_DIAS_KEY = 'governanca.api.deprecacao.consumidor_ativo_dias';
const JOB_HOUR_KEY = 'governanca.api.deprecacao.job_hora';
const CACHE_SECONDS_KEY = 'governanca.api.deprecacao.cache_segundos';
const USAGE_MINUTES_KEY = 'governanca.api.consumidor.uso_intervalo_minutos';
const WEB_APP_KEY = 'governanca.api.consumidor.app_web_chave';

const CONSUMERS_SETTING_DEFAULTS = Object.freeze({
  [AVISO_DIAS_KEY]: 30,
  [ATIVO_DIAS_KEY]: 30,
  [JOB_HOUR_KEY]: 7,
  [CACHE_SECONDS_KEY]: 30,
  [USAGE_MINUTES_KEY]: 60,
  [WEB_APP_KEY]: 'nayara-web',
});

function validateAppKey(key, value) {
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(String(value))) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ter de 1 a 60 caracteres: letras, números, ponto, hífen e sublinhado.`, { key });
}

const CONSUMERS_SETTINGS_SCHEMA = {
  [AVISO_DIAS_KEY]: { type: 'integer', min: 1, max: 365 },
  [ATIVO_DIAS_KEY]: { type: 'integer', min: 1, max: 365 },
  [JOB_HOUR_KEY]: { type: 'integer', min: 0, max: 23 },
  [CACHE_SECONDS_KEY]: { type: 'integer', min: 1, max: 3600 },
  [USAGE_MINUTES_KEY]: { type: 'integer', min: 1, max: 1440 },
  [WEB_APP_KEY]: { type: 'string', validate: validateAppKey },
};

module.exports = { AVISO_DIAS_KEY, ATIVO_DIAS_KEY, JOB_HOUR_KEY, CACHE_SECONDS_KEY, USAGE_MINUTES_KEY, WEB_APP_KEY, CONSUMERS_SETTING_DEFAULTS, CONSUMERS_SETTINGS_SCHEMA };
