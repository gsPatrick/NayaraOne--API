'use strict';

/**
 * M9-D607 — parâmetros do administrador para a atualização dos read models (aba "BI e Centro de Comando" em /painel/configuracoes).
 * Dicionário em SETTINGS_SCHEMA (settings.service.js faz o spread) + leitura por `readRefreshParams`. Sem dependência de
 * settings.service no topo do arquivo (evita ciclo; a leitura usa import tardio).
 *
 *  analytics.refresh.max_linhas_agregado  teto de linhas lidas na fonte para recalcular UM agregado por evento (BI-012); acima, vai para o job
 *  analytics.refresh.lote_segundos        intervalo mínimo entre os "fins de lote" que disparam os checks de qualidade (M9-D696)
 *  analytics.refresh.lote_linhas          agregados recalculados por transação no job agendado
 *  analytics.refresh.schedule             "a cada N min e às HH:MM Fuso" — recálculo por passagem do tempo
 *  analytics.refresh.timeout_ms           tempo máximo de cada consulta do refresh (statement_timeout)
 *  analytics.refresh.lock_timeout_ms      tempo máximo esperando uma trava (lock_timeout): o refresh nunca segura nem espera trava que atrase o usuário (M9-D698)
 */
const AppError = require('../../../utils/AppError');

const KEYS = Object.freeze({
  maxAggregateRows: 'analytics.refresh.max_linhas_agregado',
  batchSeconds: 'analytics.refresh.lote_segundos',
  batchRows: 'analytics.refresh.lote_linhas',
  schedule: 'analytics.refresh.schedule',
  timeoutMs: 'analytics.refresh.timeout_ms',
  lockTimeoutMs: 'analytics.refresh.lock_timeout_ms',
});

// Padrões do livro/demanda (M9-D607 3.2 e 3.3; parametros.csv PD-137 a PD-140 e PD-169).
const REFRESH_DEFAULTS = Object.freeze({
  [KEYS.maxAggregateRows]: 10000,
  [KEYS.batchSeconds]: 30,
  [KEYS.batchRows]: 5000,
  [KEYS.schedule]: 'a cada 15 min e às 00:05 America/Sao_Paulo',
  [KEYS.timeoutMs]: 30000,
  [KEYS.lockTimeoutMs]: 2000, // livro (M9-D698 3.4): SET LOCAL lock_timeout = '2s'
});

const SCHEDULE_RE = /^a cada (\d{1,4}) min e às (\d{2}):(\d{2}) ([A-Za-z_]+\/[A-Za-z_]+)$/;

/** { everyMinutes, dailyAt: 'HH:MM', minutesOfDay, timezone } ou null se o texto não segue "a cada N min e às HH:MM Fuso". */
function parseSchedule(text) {
  const m = SCHEDULE_RE.exec(String(text || '').trim());
  if (!m) return null;
  const every = Number.parseInt(m[1], 10);
  const hh = Number.parseInt(m[2], 10);
  const mm = Number.parseInt(m[3], 10);
  if (every < 1 || hh > 23 || mm > 59) return null;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: m[4] }).format(new Date(0));
  } catch (_err) {
    return null;
  }
  return { everyMinutes: every, dailyAt: `${m[2]}:${m[3]}`, minutesOfDay: hh * 60 + mm, timezone: m[4] };
}

function validateSchedule(key, value) {
  if (!parseSchedule(value)) {
    throw AppError.badRequest(`O valor de "${key}" deve seguir o formato: a cada 15 min e às 00:05 America/Sao_Paulo.`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

const READ_MODEL_SETTINGS_SCHEMA = {
  [KEYS.maxAggregateRows]: { type: 'integer', min: 1, max: 1000000 },
  [KEYS.batchSeconds]: { type: 'integer', min: 1, max: 3600 },
  [KEYS.batchRows]: { type: 'integer', min: 1, max: 100000 },
  [KEYS.schedule]: { type: 'string', validate: validateSchedule },
  [KEYS.timeoutMs]: { type: 'integer', min: 100, max: 600000 },
  [KEYS.lockTimeoutMs]: { type: 'integer', min: 50, max: 600000 },
};

const positiveInt = (v, fallback) => (Number.isInteger(v) && v >= 1 ? v : fallback);

/** Parâmetros vigentes do tenant (`ctx.companyId`); valor ausente ou inválido cai no padrão. */
async function readRefreshParams(ctx, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service'); // import tardio: settings.service importa este arquivo
  const get = (key) => getSetting(key, ctx, transaction, REFRESH_DEFAULTS[key]);
  const [rows, seconds, batch, schedule, timeout, lockTimeout] = await Promise.all([
    get(KEYS.maxAggregateRows), get(KEYS.batchSeconds), get(KEYS.batchRows), get(KEYS.schedule), get(KEYS.timeoutMs), get(KEYS.lockTimeoutMs),
  ]);
  return {
    maxAggregateRows: positiveInt(rows, REFRESH_DEFAULTS[KEYS.maxAggregateRows]),
    batchSeconds: positiveInt(seconds, REFRESH_DEFAULTS[KEYS.batchSeconds]),
    batchRows: positiveInt(batch, REFRESH_DEFAULTS[KEYS.batchRows]),
    schedule: parseSchedule(schedule) || parseSchedule(REFRESH_DEFAULTS[KEYS.schedule]),
    timeoutMs: positiveInt(timeout, REFRESH_DEFAULTS[KEYS.timeoutMs]),
    lockTimeoutMs: positiveInt(lockTimeout, REFRESH_DEFAULTS[KEYS.lockTimeoutMs]),
  };
}

module.exports = { KEYS, REFRESH_DEFAULTS, READ_MODEL_SETTINGS_SCHEMA, parseSchedule, readRefreshParams };
