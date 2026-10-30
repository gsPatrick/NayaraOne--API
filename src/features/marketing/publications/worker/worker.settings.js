'use strict';

const { mktError } = require('../../marketing.errors');

/**
 * M9-D411 — parâmetros do worker de publicação (aba Marketing de Configurações; padrão = Maturacao/demandas/parametros.csv). Lidos por getSetting a cada ciclo:
 * intervalo entre ciclos, lote, espera de cada retentativa, tentativas no total, espera entre reconciliações, limite do UNKNOWN, tempo máximo do adapter e os
 * dias das coletas de métrica (D+0, D+1, D+7 do livro, inferidos do contexto).
 */
const KEYS = Object.freeze({
  interval: 'marketing.worker.intervalo_s',
  batch: 'marketing.worker.lote',
  backoff: 'marketing.worker.backoff_s',
  attempts: 'marketing.worker.max_tentativas',
  reconcile: 'marketing.worker.reconcile_s',
  reconcileMaxH: 'marketing.worker.reconcile_max_h',
  timeout: 'marketing.worker.timeout_s',
  metricDays: 'marketing.worker.metricas_dias',
});

const WORKER_SETTING_DEFAULTS = Object.freeze({
  [KEYS.interval]: 30, [KEYS.batch]: 20, [KEYS.backoff]: '[60,300]', [KEYS.attempts]: 3, [KEYS.reconcile]: 120, [KEYS.reconcileMaxH]: 24, [KEYS.timeout]: 30, [KEYS.metricDays]: '[0,1,7]',
});

const LISTS = Object.freeze({
  [KEYS.backoff]: { min: 1, max: 86400, ordered: false, expected: 'lista de segundos inteiros (um valor por retentativa), ex.: 60,300' },
  [KEYS.metricDays]: { min: 0, max: 365, ordered: true, expected: 'lista crescente de dias inteiros após a publicação, ex.: 0,1,7' },
});
const MAX_LIST = 20;

/** "60, 300" ou "[60,300]" -> [60, 300]; null quando não é lista de inteiros dentro da faixa (e crescente, quando a chave exige). */
function parseList(key, text) {
  if (typeof text !== 'string') return null;
  const rule = LISTS[key];
  const parts = text.trim().replace(/^\[/, '').replace(/\]$/, '').split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.length > MAX_LIST) return null;
  const out = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < rule.min || n > rule.max) return null;
    if (rule.ordered && out.length > 0 && n <= out[out.length - 1]) return null;
    out.push(n);
  }
  return out;
}

function validateList(key, value) {
  if (!parseList(key, value)) throw mktError(422, 'MKT_PARAM_INVALID', 'Valor inválido para o parâmetro.', { key, value, esperado: LISTS[key].expected });
}

const WORKER_SETTINGS_SCHEMA = {
  [KEYS.interval]: { type: 'integer', min: 5, max: 3600 },
  [KEYS.batch]: { type: 'integer', min: 1, max: 500 },
  [KEYS.backoff]: { type: 'string', validate: validateList },
  [KEYS.attempts]: { type: 'integer', min: 1, max: 10 },
  [KEYS.reconcile]: { type: 'integer', min: 5, max: 86400 },
  [KEYS.reconcileMaxH]: { type: 'integer', min: 1, max: 720 },
  [KEYS.timeout]: { type: 'integer', min: 1, max: 600 },
  [KEYS.metricDays]: { type: 'string', validate: validateList },
};

async function readInt(key, tenant, transaction) {
  const { getSetting } = require('../../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const value = Number(await getSetting(key, tenant, transaction, WORKER_SETTING_DEFAULTS[key]));
  return Number.isInteger(value) && value >= 1 ? value : WORKER_SETTING_DEFAULTS[key];
}

async function readList(key, tenant, transaction) {
  const { getSetting } = require('../../../settings/settings.service');
  return parseList(key, String(await getSetting(key, tenant, transaction, WORKER_SETTING_DEFAULTS[key]))) || parseList(key, WORKER_SETTING_DEFAULTS[key]);
}

/** Parâmetros do worker da empresa, lidos na hora (nada em cache). */
async function readWorkerParams(tenant, transaction) {
  return {
    intervalS: await readInt(KEYS.interval, tenant, transaction),
    batch: await readInt(KEYS.batch, tenant, transaction),
    backoffS: await readList(KEYS.backoff, tenant, transaction),
    maxAttempts: await readInt(KEYS.attempts, tenant, transaction),
    reconcileS: await readInt(KEYS.reconcile, tenant, transaction),
    reconcileMaxH: await readInt(KEYS.reconcileMaxH, tenant, transaction),
    timeoutS: await readInt(KEYS.timeout, tenant, transaction),
    metricDays: await readList(KEYS.metricDays, tenant, transaction),
  };
}

/** Espera (s) antes da retentativa de número `retryNo` (1 = primeira retentativa): um valor por retentativa; lista curta repete o último. */
const backoffFor = (list, retryNo) => list[Math.min(Math.max(retryNo, 1), list.length) - 1];

module.exports = { KEYS, WORKER_SETTING_DEFAULTS, WORKER_SETTINGS_SCHEMA, readWorkerParams, parseList, backoffFor };
