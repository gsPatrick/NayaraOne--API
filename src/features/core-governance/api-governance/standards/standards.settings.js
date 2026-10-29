'use strict';

/**
 * Parâmetros dos padrões de API (M9-D843; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv). O limite anônimo
 * (governanca.api.rate_limit.anonimo_por_minuto) é da M9-D823 e vale também aqui.
 *  - governanca.api.rate_limit.habilitado: liga o limite de requisições (padrão ligado).
 *  - governanca.api.rate_limit.interno_por_minuto: requisições por minuto por usuário logado (padrão 1200; o tráfego manual é o dobro do automatizado).
 *  - governanca.api.rate_limit.externo_por_minuto: requisições por minuto por credencial de API externa (padrão 600).
 *  - governanca.api.paginacao.tamanho_padrao: pageSize quando o cliente não informa (padrão 50; o teto de 200 é do livro e não muda).
 *  - governanca.api.idempotencia.validade_horas: por quanto tempo a chave devolve a resposta original (padrão 24).
 *  - governanca.api.idempotencia.espera_segundos: quanto uma repetição simultânea espera a resposta da primeira antes de responder 409 (padrão 10).
 *  - governanca.api.limpeza_job_minutos: de quanto em quanto tempo os jobs apagam janelas de contador e chaves vencidas (padrão 10).
 */
const RATE_ENABLED_KEY = 'governanca.api.rate_limit.habilitado';
const RATE_INTERNAL_KEY = 'governanca.api.rate_limit.interno_por_minuto';
const RATE_EXTERNAL_KEY = 'governanca.api.rate_limit.externo_por_minuto';
const PAGE_SIZE_KEY = 'governanca.api.paginacao.tamanho_padrao';
const IDEM_HOURS_KEY = 'governanca.api.idempotencia.validade_horas';
const IDEM_WAIT_KEY = 'governanca.api.idempotencia.espera_segundos';
const CLEANUP_MINUTES_KEY = 'governanca.api.limpeza_job_minutos';

const STANDARDS_SETTING_DEFAULTS = Object.freeze({
  [RATE_ENABLED_KEY]: true,
  [RATE_INTERNAL_KEY]: 1200,
  [RATE_EXTERNAL_KEY]: 600,
  [PAGE_SIZE_KEY]: 50,
  [IDEM_HOURS_KEY]: 24,
  [IDEM_WAIT_KEY]: 10,
  [CLEANUP_MINUTES_KEY]: 10,
});

const STANDARDS_SETTINGS_SCHEMA = {
  [RATE_ENABLED_KEY]: { type: 'boolean' },
  [RATE_INTERNAL_KEY]: { type: 'integer', min: 1, max: 1000000 },
  [RATE_EXTERNAL_KEY]: { type: 'integer', min: 1, max: 1000000 },
  [PAGE_SIZE_KEY]: { type: 'integer', min: 1, max: 200 },
  [IDEM_HOURS_KEY]: { type: 'integer', min: 1, max: 720 },
  [IDEM_WAIT_KEY]: { type: 'integer', min: 1, max: 120 },
  [CLEANUP_MINUTES_KEY]: { type: 'integer', min: 1, max: 1440 },
};

module.exports = {
  RATE_ENABLED_KEY, RATE_INTERNAL_KEY, RATE_EXTERNAL_KEY, PAGE_SIZE_KEY, IDEM_HOURS_KEY, IDEM_WAIT_KEY, CLEANUP_MINUTES_KEY, STANDARDS_SETTING_DEFAULTS, STANDARDS_SETTINGS_SCHEMA,
};
