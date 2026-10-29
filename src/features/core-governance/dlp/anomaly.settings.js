'use strict';

const { govError } = require('../governance.errors');

/**
 * Parâmetros da anomalia de acesso em massa (M9-D824; catálogo em Maturacao/demandas/parametros.csv; aba Governança em /painel/configuracoes).
 *  - governanca.dlp.anomalia.limiares: "HIGH 200/10; RESTRICTED 20/10; EXPORT 3/30" = item/minutos. Leitura (HIGH e RESTRICTED, somando cópias): anomalia quando a
 *    soma na janela PASSA de N; exportação (EXPORT, SHARE e PRINT, aprovados ou bloqueados): anomalia quando a soma ATINGE N (o livro diz "3 ou mais").
 *  - governanca.dlp.anomalia.mfa_horas: por quanto tempo o MFA verificado antes da detecção deixa de valer (a próxima ação sensível pede MFA novo).
 *  - governanca.dlp.anomalia.suspensao_horas: duração de EXPORT, SHARE e PRINT suspensos até a revisão.
 *  - governanca.dlp.anomalia.confirmada_horas: a suspensão a partir da confirmação humana; ao vencer, cai sozinha.
 */
const THRESHOLDS_KEY = 'governanca.dlp.anomalia.limiares';
const MFA_HOURS_KEY = 'governanca.dlp.anomalia.mfa_horas';
const SUSPENSION_HOURS_KEY = 'governanca.dlp.anomalia.suspensao_horas';
const CONFIRMED_HOURS_KEY = 'governanca.dlp.anomalia.confirmada_horas';

const THRESHOLD_NAMES = Object.freeze(['HIGH', 'RESTRICTED', 'EXPORT']);

const ANOMALY_SETTING_DEFAULTS = Object.freeze({
  [THRESHOLDS_KEY]: 'HIGH 200/10; RESTRICTED 20/10; EXPORT 3/30',
  [MFA_HOURS_KEY]: 24,
  [SUSPENSION_HOURS_KEY]: 24,
  [CONFIRMED_HOURS_KEY]: 168,
});

const PAIR = /^([A-Za-z]+)\s+([1-9][0-9]{0,8})\s*\/\s*([1-9][0-9]{0,5})$/;

/** "HIGH 200/10; EXPORT 3/30" -> { HIGH: { limit: 200, minutes: 10 }, EXPORT: {...} }; null se algum item estiver fora do formato. */
function parsePairs(text) {
  const out = {};
  for (const part of String(text).split(';').map((p) => p.trim()).filter(Boolean)) {
    const match = PAIR.exec(part);
    if (!match || !THRESHOLD_NAMES.includes(match[1].toUpperCase())) return null;
    out[match[1].toUpperCase()] = { limit: Number(match[2]), minutes: Number(match[3]) };
  }
  return out;
}

function validateThresholds(key, value) {
  const pairs = parsePairs(value);
  if (!pairs || THRESHOLD_NAMES.some((name) => !(name in pairs))) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve trazer HIGH, RESTRICTED e EXPORT no formato "HIGH 200/10; RESTRICTED 20/10; EXPORT 3/30" (itens/minutos).`, { key, value });
  }
}

const ANOMALY_SETTINGS_SCHEMA = {
  [THRESHOLDS_KEY]: { type: 'string', validate: validateThresholds },
  [MFA_HOURS_KEY]: { type: 'integer', min: 1, max: 8760 },
  [SUSPENSION_HOURS_KEY]: { type: 'integer', min: 1, max: 8760 },
  [CONFIRMED_HOURS_KEY]: { type: 'integer', min: 1, max: 8760 },
};

/** Limiares prontos; item ausente ou inválido cai no padrão do catálogo daquele item. */
function parseThresholds(text) {
  const fallback = parsePairs(ANOMALY_SETTING_DEFAULTS[THRESHOLDS_KEY]);
  const given = parsePairs(typeof text === 'string' ? text : '') || {};
  const out = {};
  for (const name of THRESHOLD_NAMES) out[name] = given[name] || fallback[name];
  return out;
}

const parseHours = (value, key) => (Number.isInteger(value) && value >= 1 ? value : ANOMALY_SETTING_DEFAULTS[key]);

module.exports = {
  THRESHOLDS_KEY, MFA_HOURS_KEY, SUSPENSION_HOURS_KEY, CONFIRMED_HOURS_KEY, ANOMALY_SETTING_DEFAULTS, ANOMALY_SETTINGS_SCHEMA, THRESHOLD_NAMES, parseThresholds, parseHours,
};
