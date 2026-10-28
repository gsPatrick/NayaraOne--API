'use strict';

/**
 * M9-D417 (MKT-005) — ÚNICO lugar do módulo Marketing com os números de cadência, quiet hours e frequency cap. São os padrões
 * de Maturacao/demandas/parametros.csv; o administrador troca os valores em /painel/configuracoes (aba Marketing) e o código
 * só os lê por getMarketingParam. Nenhum outro arquivo do módulo pode repetir estes literais (teste estático no-hardcoded-cadence).
 */
const POS_KEYS_DAYS_KEY = 'marketing.cadencia.pos_chaves_dias';
const RENTAL_DAYS_KEY = 'marketing.cadencia.locacao_dias';
const NO_REPLY_DAYS_KEY = 'marketing.cadencia.sem_retorno_dias';
const QUIET_HOURS_KEY = 'marketing.quiet_hours';
const FREQUENCY_CAP_KEY = 'marketing.frequency_cap.global';

const CADENCE_DEFAULTS = Object.freeze({
  [POS_KEYS_DAYS_KEY]: '[3,30,90,365]',
  [RENTAL_DAYS_KEY]: '[7,15,30,90,180]',
  [NO_REPLY_DAYS_KEY]: '[1,3,7]',
  [QUIET_HOURS_KEY]: '21:00 a 08:00 America/Sao_Paulo',
  [FREQUENCY_CAP_KEY]: '3 mensagens por 7 dias por pessoa, canal e finalidade',
});

const EXPECTED = Object.freeze({
  [POS_KEYS_DAYS_KEY]: 'lista crescente de dias inteiros, ex.: 3,30,90,365',
  [RENTAL_DAYS_KEY]: 'lista crescente de dias inteiros, ex.: 7,15,30,90,180',
  [NO_REPLY_DAYS_KEY]: 'lista crescente de dias inteiros, ex.: 1,3,7',
  [QUIET_HOURS_KEY]: 'HH:MM a HH:MM fuso, ex.: 21:00 a 08:00 America/Sao_Paulo',
  [FREQUENCY_CAP_KEY]: 'N mensagens por M dias, ex.: 3 mensagens por 7 dias por pessoa, canal e finalidade',
});

/** Faixas aceitas na escrita (valor fora delas: 422 MKT_PARAM_INVALID). */
const CADENCE_LIMITS = Object.freeze({
  maxListItems: 20,
  minDay: 1,
  maxDay: 3650,
  maxCapMessages: 1000,
  maxCapDays: 365,
});

module.exports = {
  POS_KEYS_DAYS_KEY, RENTAL_DAYS_KEY, NO_REPLY_DAYS_KEY, QUIET_HOURS_KEY, FREQUENCY_CAP_KEY, CADENCE_DEFAULTS, CADENCE_LIMITS, EXPECTED,
};
