'use strict';

/**
 * Parâmetros da validação de relógio (M9-D908 §3.1; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv):
 *  - migracao.relogio.deriva_max_s (P9-EF-073): maior diferença aceita entre os relógios da aplicação, do banco de destino, do NTP e da fonte antiga, em segundos (padrão 2).
 *  - migracao.relogio.reverificar_min: de quantos em quantos minutos a conferência se repete enquanto o aplicador está pausado ou a deriva está aberta (padrão 5).
 *  - migracao.relogio.ntp_ativo: consulta o NTP na conferência (padrão ligado). Desligue num laboratório sem acesso à internet: o relógio do banco e da fonte continuam conferidos.
 *  - migracao.relogio.ntp_servidor: servidor NTP consultado pelo processo da API, `servidor` ou `servidor:porta` (padrão pool.ntp.org).
 *  - migracao.relogio.ntp_timeout_ms: tempo máximo de espera pela resposta do NTP, em milissegundos (padrão 3000); sem resposta, a leitura do NTP conta como não medida.
 */
const KEYS = Object.freeze({
  MAX_DRIFT_S: 'migracao.relogio.deriva_max_s',
  RECHECK_MIN: 'migracao.relogio.reverificar_min',
  NTP_ENABLED: 'migracao.relogio.ntp_ativo',
  NTP_SERVER: 'migracao.relogio.ntp_servidor',
  NTP_TIMEOUT_MS: 'migracao.relogio.ntp_timeout_ms',
});

const CLOCK_SETTING_DEFAULTS = Object.freeze({
  [KEYS.MAX_DRIFT_S]: 2, [KEYS.RECHECK_MIN]: 5, [KEYS.NTP_ENABLED]: true, [KEYS.NTP_SERVER]: 'pool.ntp.org', [KEYS.NTP_TIMEOUT_MS]: 3000,
});

const CLOCK_SETTINGS_SCHEMA = {
  [KEYS.MAX_DRIFT_S]: { type: 'integer', min: 0, max: 3600 },
  [KEYS.RECHECK_MIN]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.NTP_ENABLED]: { type: 'boolean' },
  [KEYS.NTP_SERVER]: { type: 'string' },
  [KEYS.NTP_TIMEOUT_MS]: { type: 'integer', min: 100, max: 60000 },
};

module.exports = { KEYS, CLOCK_SETTING_DEFAULTS, CLOCK_SETTINGS_SCHEMA };
