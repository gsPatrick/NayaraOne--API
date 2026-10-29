'use strict';

const { govError } = require('../../governance.errors');

/**
 * Parâmetros dos links externos (M9-D823; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv). O prazo do link NÃO está aqui: é o
 * `max_expiry_hours` da política SHARE da classe (governanca.dlp.expiracao_horas_da_classe, M9-D820).
 *  - governanca.api.rate_limit.anonimo_por_minuto: acessos por minuto, por IP, nas rotas sem login (M9-D843 §3.1; aqui o consumidor é /public/share/:token).
 *  - governanca.dlp.link.url_base: endereço público (ex.: o do site) que abre o link; AUTO usa o endereço da própria requisição.
 *  - governanca.dlp.link.expiracao_job_minutos: de quanto em quanto tempo o shareLinkExpiryJob marca os links vencidos (padrão 5).
 *  - governanca.dlp.link.prazo_sem_teto_horas: prazo máximo do link quando a política da classe não tem teto (nunca existe link sem prazo; padrão 168 h).
 *  - governanca.dlp.link.arquivo_texto_marca: texto da marca d'água do arquivo entregue pelo link (variáveis {destinatario}, {data}, {link}).
 */
const RATE_KEY = 'governanca.api.rate_limit.anonimo_por_minuto';
const URL_BASE_KEY = 'governanca.dlp.link.url_base';
const JOB_MINUTES_KEY = 'governanca.dlp.link.expiracao_job_minutos';
const FILE_MARK_KEY = 'governanca.dlp.link.arquivo_texto_marca';
const NO_CEILING_KEY = 'governanca.dlp.link.prazo_sem_teto_horas';

const SHARE_SETTING_DEFAULTS = Object.freeze({
  [RATE_KEY]: 60,
  [URL_BASE_KEY]: 'AUTO',
  [JOB_MINUTES_KEY]: 5,
  [FILE_MARK_KEY]: 'Nayara One · {destinatario} · {data} · {link}',
  [NO_CEILING_KEY]: 168,
});

function validateUrlBase(key, value) {
  const text = String(value).trim();
  if (text !== 'AUTO' && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(text)) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser AUTO ou um endereço http(s) sem parâmetros.`, { key, value });
}
function validateMark(key, value) {
  if (!String(value).trim() || String(value).length > 200) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ter de 1 a 200 caracteres.`, { key, value });
}

const SHARE_SETTINGS_SCHEMA = {
  [RATE_KEY]: { type: 'integer', min: 1, max: 100000 },
  [URL_BASE_KEY]: { type: 'string', validate: validateUrlBase },
  [JOB_MINUTES_KEY]: { type: 'integer', min: 1, max: 1440 },
  [FILE_MARK_KEY]: { type: 'string', validate: validateMark },
  [NO_CEILING_KEY]: { type: 'integer', min: 1, max: 8760 },
};

const intOr = (value, key) => (Number.isInteger(value) && value >= 1 ? value : SHARE_SETTING_DEFAULTS[key]);
const urlBase = (value) => (typeof value === 'string' && value.trim() !== 'AUTO' ? value.trim().replace(/\/+$/, '') : '');
const markTemplate = (value) => (typeof value === 'string' && value.trim() ? value : SHARE_SETTING_DEFAULTS[FILE_MARK_KEY]);

module.exports = { RATE_KEY, URL_BASE_KEY, JOB_MINUTES_KEY, FILE_MARK_KEY, NO_CEILING_KEY, SHARE_SETTING_DEFAULTS, SHARE_SETTINGS_SCHEMA, intOr, urlBase, markTemplate };
