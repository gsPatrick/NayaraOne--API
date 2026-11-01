'use strict';

const { CLASSES } = require('./dlp.constants');
const { ANOMALY_SETTING_DEFAULTS, ANOMALY_SETTINGS_SCHEMA } = require('./anomaly.settings');
const { VIEW_SETTING_DEFAULTS, VIEW_SETTINGS_SCHEMA } = require('./view.settings');
const { EXPORT_SETTING_DEFAULTS, EXPORT_SETTINGS_SCHEMA } = require('./exports/export.settings');
const { SHARE_SETTING_DEFAULTS, SHARE_SETTINGS_SCHEMA } = require('./share/share.settings');
const { DOWNLOAD_SETTING_DEFAULTS, DOWNLOAD_SETTINGS_SCHEMA } = require('./downloads/download.settings');
const { PRINT_SETTING_DEFAULTS, PRINT_SETTINGS_SCHEMA } = require('./print/print.settings');

/**
 * Parâmetros do DLP (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.dlp.classificacao_padrao: classe de quem não tem registro de classificação (padrão HIGH, conservador).
 *  - governanca.dlp.volume_teto_por_classe: `max_rows` inicial da política de EXPORT de cada classe (LOW 100.000; MEDIUM 50.000; HIGH 10.000; RESTRICTED 1.000).
 *  - governanca.dlp.expiracao_horas_da_classe: `max_expiry_hours` inicial de EXPORT e SHARE (LOW 168; MEDIUM 72; HIGH 48; RESTRICTED 24); é o ÚNICO parâmetro de prazo.
 *  - governanca.dlp.watermark.padrao_por_classe: `require_watermark` inicial por classe (o livro: marca d'água opcional, então tudo desligado).
 *  - governanca.dlp.finalidades e governanca.dlp.justificativa_min: catálogo de finalidades e mínimo de caracteres da justificativa (M9-D821 etapa 3).
 * Os três mapas por classe só definem a política INICIAL de uma empresa; depois de criada, a tabela governance.dlp_policies é a fonte (o administrador edita por PUT).
 */
const DEFAULT_CLASS_KEY = 'governanca.dlp.classificacao_padrao';
const PURPOSES_KEY = 'governanca.dlp.finalidades';
const JUSTIFICATION_MIN_KEY = 'governanca.dlp.justificativa_min';
const VOLUME_KEY = 'governanca.dlp.volume_teto_por_classe';
const EXPIRY_KEY = 'governanca.dlp.expiracao_horas_da_classe';
const WATERMARK_KEY = 'governanca.dlp.watermark.padrao_por_classe';

const WATERMARK_ON = 'ligado';
const WATERMARK_OFF = 'desligado';

const DLP_SETTING_DEFAULTS = Object.freeze({
  [DEFAULT_CLASS_KEY]: 'HIGH',
  [PURPOSES_KEY]: 'AUDITORIA,OPERACAO,JURIDICO,CONTABIL,CLIENTE_SOLICITOU,OUTRA',
  [JUSTIFICATION_MIN_KEY]: 20,
  [VOLUME_KEY]: 'LOW 100000; MEDIUM 50000; HIGH 10000; RESTRICTED 1000',
  [EXPIRY_KEY]: 'LOW 168; MEDIUM 72; HIGH 48; RESTRICTED 24',
  [WATERMARK_KEY]: 'LOW desligado; MEDIUM desligado; HIGH desligado; RESTRICTED desligado',
  ...ANOMALY_SETTING_DEFAULTS,
  ...VIEW_SETTING_DEFAULTS,
  ...EXPORT_SETTING_DEFAULTS,
  ...SHARE_SETTING_DEFAULTS,
  ...DOWNLOAD_SETTING_DEFAULTS,
  ...PRINT_SETTING_DEFAULTS,
});

/** "LOW 10; MEDIUM 5" -> { LOW: '10', MEDIUM: '5' }; null se algum par estiver fora do formato. */
function parsePairs(text) {
  const out = {};
  for (const part of String(text).split(';').map((p) => p.trim()).filter(Boolean)) {
    const match = /^([A-Za-z]+)\s+(\S+)$/.exec(part);
    if (!match || !CLASSES.includes(match[1].toUpperCase())) return null;
    out[match[1].toUpperCase()] = match[2];
  }
  return out;
}

function classMapValidator(valid) {
  return (key, value) => {
    const { govError } = require('../governance.errors');
    const pairs = parsePairs(value);
    if (!pairs || CLASSES.some((c) => !(c in pairs) || !valid(pairs[c]))) {
      throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve trazer as quatro classes (LOW, MEDIUM, HIGH, RESTRICTED) no formato "LOW 10; MEDIUM 5; HIGH 3; RESTRICTED 1".`, { key, value });
    }
  };
}
const positiveInt = (v) => /^[1-9][0-9]{0,8}$/.test(v);
const onOff = (v) => [WATERMARK_ON, WATERMARK_OFF].includes(v.toLowerCase());

const CODE_LIST = /^[A-Z][A-Z0-9_]{0,39}$/;
function validatePurposes(key, value) {
  const { govError } = require('../governance.errors');
  const items = String(value).split(',').map((v) => v.trim()).filter(Boolean);
  if (!items.length || items.some((v) => !CODE_LIST.test(v.toUpperCase()))) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar finalidades separadas por vírgula (letras, números e _; começando por letra).`, { key, value });
  }
}
function validateDefaultClass(key, value) {
  const { govError } = require('../governance.errors');
  if (!CLASSES.includes(String(value).toUpperCase())) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser LOW, MEDIUM, HIGH ou RESTRICTED.`, { key, value });
}

const DLP_SETTINGS_SCHEMA = {
  [DEFAULT_CLASS_KEY]: { type: 'string', validate: validateDefaultClass },
  [PURPOSES_KEY]: { type: 'string', validate: validatePurposes },
  [JUSTIFICATION_MIN_KEY]: { type: 'integer', min: 20, max: 2000 },
  [VOLUME_KEY]: { type: 'string', validate: classMapValidator(positiveInt) },
  [EXPIRY_KEY]: { type: 'string', validate: classMapValidator((v) => positiveInt(v) && Number(v) <= 8760) },
  [WATERMARK_KEY]: { type: 'string', validate: classMapValidator(onOff) },
  ...ANOMALY_SETTINGS_SCHEMA,
  ...VIEW_SETTINGS_SCHEMA,
  ...EXPORT_SETTINGS_SCHEMA,
  ...SHARE_SETTINGS_SCHEMA,
  ...DOWNLOAD_SETTINGS_SCHEMA,
  ...PRINT_SETTINGS_SCHEMA,
};

/** Mapa por classe já convertido; valor ausente ou inválido cai no padrão do catálogo daquela classe. */
function classMap(text, key, convert) {
  const fallback = parsePairs(DLP_SETTING_DEFAULTS[key]);
  const given = parsePairs(typeof text === 'string' ? text : '') || {};
  const out = {};
  for (const c of CLASSES) out[c] = convert(given[c] !== undefined ? given[c] : fallback[c], fallback[c]);
  return out;
}
const toInt = (v, fallback) => (positiveInt(v) ? Number(v) : Number(fallback));
const toBool = (v, fallback) => (onOff(v) ? v.toLowerCase() === WATERMARK_ON : fallback.toLowerCase() === WATERMARK_ON);

const parseVolume = (text) => classMap(text, VOLUME_KEY, toInt);
const parseExpiry = (text) => classMap(text, EXPIRY_KEY, toInt);
const parseWatermark = (text) => classMap(text, WATERMARK_KEY, toBool);
const parseDefaultClass = (text) => (CLASSES.includes(String(text).toUpperCase()) ? String(text).toUpperCase() : DLP_SETTING_DEFAULTS[DEFAULT_CLASS_KEY]);
const parsePurposes = (text) => {
  const list = [...new Set(String(typeof text === 'string' ? text : '').split(',').map((v) => v.trim().toUpperCase()).filter((v) => CODE_LIST.test(v)))];
  return list.length ? list : DLP_SETTING_DEFAULTS[PURPOSES_KEY].split(',');
};
const parseJustificationMin = (value) => (Number.isInteger(value) && value >= 1 ? value : DLP_SETTING_DEFAULTS[JUSTIFICATION_MIN_KEY]);

module.exports = {
  DEFAULT_CLASS_KEY, PURPOSES_KEY, JUSTIFICATION_MIN_KEY, VOLUME_KEY, EXPIRY_KEY, WATERMARK_KEY, DLP_SETTING_DEFAULTS, DLP_SETTINGS_SCHEMA,
  parseVolume, parseExpiry, parseWatermark, parseDefaultClass, parsePurposes, parseJustificationMin,
};
