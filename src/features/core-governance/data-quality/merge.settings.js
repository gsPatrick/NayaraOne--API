'use strict';

const { REASONS } = require('./merge.constants');

/**
 * Parâmetros da fila de merge (aba Governança; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.dados.merge.score_minimo (P9-EF-008): score a partir do qual o par entra na fila (padrão 70).
 *  - governanca.dados.merge.scores: score de cada regra de detecção (padrão do item 3.2 da M9-D805).
 *  - governanca.dados.merge.distancia_nome_max: distância de edição aceita entre nomes (padrão 2).
 *  - governanca.dados.merge.area_diferenca_max_pct: diferença máxima de área entre imóveis, em % (padrão 3).
 *  - governanca.dados.merge.deteccao_hora: hora da detecção noturna, horário de Brasília (padrão 3).
 *  - governanca.dados.merge.lista_tamanho_padrao: itens por página de GET /data-quality/queue (padrão 50).
 */
const MIN_SCORE_KEY = 'governanca.dados.merge.score_minimo';
const SCORES_KEY = 'governanca.dados.merge.scores';
const NAME_DISTANCE_KEY = 'governanca.dados.merge.distancia_nome_max';
const AREA_DIFF_KEY = 'governanca.dados.merge.area_diferenca_max_pct';
const DETECTION_HOUR_KEY = 'governanca.dados.merge.deteccao_hora';
const PAGE_SIZE_KEY = 'governanca.dados.merge.lista_tamanho_padrao';

const DETECTOR_REASONS = Object.freeze(Object.values(REASONS).filter((code) => code !== REASONS.QUALITY_CRITICAL));
const DEFAULT_SCORES = 'PERSON_TAX_ID=100, PERSON_NAME_CONTACT=85, PERSON_NAME_BIRTH=70, PROPERTY_REGISTRY=95, PROPERTY_ADDRESS_UNIT=95, PROPERTY_ADDRESS_AREA=75, SUPPLIER_CNPJ_ROOT=90, SUPPLIER_NAME=80';

/** "A=1, B=2" -> { A: 1, B: 2 } (só regras conhecidas, score de 0 a 100; o resto sai). */
function parseScores(text) {
  const out = {};
  String(typeof text === 'string' ? text : '').split(',').forEach((pair) => {
    const [code, raw] = pair.split('=').map((v) => v.trim());
    const value = Number(raw);
    if (DETECTOR_REASONS.includes(code) && raw !== '' && Number.isFinite(value) && value >= 0 && value <= 100) out[code] = value;
  });
  return out;
}

function validateScores(key, value) {
  const { govError } = require('../governance.errors');
  const pairs = String(value).split(',').map((v) => v.trim()).filter(Boolean);
  const parsed = parseScores(value);
  const bad = pairs.filter((pair) => !(pair.split('=')[0].trim() in parsed));
  if (!pairs.length || bad.length) {
    throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve listar REGRA=score (0 a 100) separados por vírgula, entre: ${DETECTOR_REASONS.join(', ')}.`, { key, invalid: bad });
  }
}

const MERGE_SETTING_DEFAULTS = Object.freeze({
  [MIN_SCORE_KEY]: 70, [SCORES_KEY]: DEFAULT_SCORES, [NAME_DISTANCE_KEY]: 2, [AREA_DIFF_KEY]: 3, [DETECTION_HOUR_KEY]: 3, [PAGE_SIZE_KEY]: 50,
});
const MERGE_SETTINGS_SCHEMA = {
  [MIN_SCORE_KEY]: { type: 'integer', min: 0, max: 100 },
  [SCORES_KEY]: { type: 'string', validate: validateScores },
  [NAME_DISTANCE_KEY]: { type: 'integer', min: 0, max: 10 },
  [AREA_DIFF_KEY]: { type: 'integer', min: 0, max: 100 },
  [DETECTION_HOUR_KEY]: { type: 'integer', min: 0, max: 23 },
  [PAGE_SIZE_KEY]: { type: 'integer', min: 1, max: 200 },
};

module.exports = {
  MIN_SCORE_KEY, SCORES_KEY, NAME_DISTANCE_KEY, AREA_DIFF_KEY, DETECTION_HOUR_KEY, PAGE_SIZE_KEY, DEFAULT_SCORES, MERGE_SETTING_DEFAULTS, MERGE_SETTINGS_SCHEMA, parseScores,
};
