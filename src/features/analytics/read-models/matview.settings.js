'use strict';

/**
 * M9-D698 (3.2) — agenda das materialized views do BI (aba "BI e Centro de Comando" em /painel/configuracoes). A série histórica muda no máximo
 * a cada dia-base, então o padrão é recalcular a cada 6 horas e logo depois da virada do dia (00:40 de São Paulo, depois da passada das 00:05 dos
 * read models). Mesmo formato da agenda dos read models: "a cada N min e às HH:MM Fuso".
 *
 *  analytics.mv.schedule   agenda do refresh concorrente das materialized views (analytics.mv_*)
 */
const { parseSchedule, READ_MODEL_SETTINGS_SCHEMA } = require('./readModel.settings');

const KEYS = Object.freeze({ schedule: 'analytics.mv.schedule' });
const MV_DEFAULTS = Object.freeze({ [KEYS.schedule]: 'a cada 360 min e às 00:40 America/Sao_Paulo' });

const MV_SETTINGS_SCHEMA = {
  [KEYS.schedule]: { type: 'string', validate: READ_MODEL_SETTINGS_SCHEMA['analytics.refresh.schedule'].validate },
};

/** Agenda vigente da empresa (texto inválido cai no padrão). Import tardio do settings.service: ele importa este arquivo. */
async function readMvParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const text = await getSetting(KEYS.schedule, scope, transaction, MV_DEFAULTS[KEYS.schedule]);
  return { schedule: parseSchedule(text) || parseSchedule(MV_DEFAULTS[KEYS.schedule]) };
}

module.exports = { KEYS, MV_DEFAULTS, MV_SETTINGS_SCHEMA, parseMvSchedule: parseSchedule, readMvParams };
