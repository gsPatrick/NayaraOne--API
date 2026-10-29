'use strict';

/**
 * M9-D609 (3.3) — parâmetros do administrador para o snapshot diário do BI (aba "BI e Centro de Comando" em /painel/configuracoes).
 * Dicionário em SETTINGS_SCHEMA (settings.service.js faz o spread) + leitura por `readSnapshotParams`.
 *
 *  analytics.snapshot.hora_execucao        HH:MM (fuso de São Paulo) a partir da qual o job fotografa o dia anterior (livro: 00:30)
 *  analytics.snapshot.dias_retroativos_max até quantos dias para trás o catch-up grava um dia que o job perdeu (limita o reprocesso)
 */
const AppError = require('../../../utils/AppError');

const KEYS = Object.freeze({ time: 'analytics.snapshot.hora_execucao', maxBackfillDays: 'analytics.snapshot.dias_retroativos_max' });
const DEFAULTS = Object.freeze({ [KEYS.time]: '00:30', [KEYS.maxBackfillDays]: 31 });
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (text) => {
  const m = TIME_RE.exec(String(text ?? '').trim());
  return m ? Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10) : null;
};

function validateTime(key, value) {
  if (minutesOf(value) === null) throw AppError.badRequest(`O valor de "${key}" deve ser uma hora no formato HH:MM (24 horas), por exemplo 00:30.`, 'SETTING_INVALID_VALUE', { key, value });
}

const SNAPSHOT_SETTINGS_SCHEMA = {
  [KEYS.time]: { type: 'string', validate: validateTime },
  [KEYS.maxBackfillDays]: { type: 'integer', min: 1, max: 366 },
};

/** { atMinutes, atText, maxBackfillDays } vigentes da empresa; valor ausente ou inválido cai no padrão. */
async function readSnapshotParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service'); // import tardio: settings.service importa este arquivo
  const [time, days] = await Promise.all([
    getSetting(KEYS.time, scope, transaction, DEFAULTS[KEYS.time]), getSetting(KEYS.maxBackfillDays, scope, transaction, DEFAULTS[KEYS.maxBackfillDays]),
  ]);
  const atText = minutesOf(time) === null ? DEFAULTS[KEYS.time] : String(time).trim();
  return { atText, atMinutes: minutesOf(atText), maxBackfillDays: Number.isInteger(days) && days >= 1 && days <= 366 ? days : DEFAULTS[KEYS.maxBackfillDays] };
}

module.exports = { KEYS, DEFAULTS, SNAPSHOT_SETTINGS_SCHEMA, readSnapshotParams, minutesOf };
