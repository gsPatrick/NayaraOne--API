'use strict';

/**
 * M9-D432 — parâmetros do custo real da campanha (aba Marketing de /painel/configuracoes). SETTINGS_SCHEMA fail-closed + getSetting.
 * `fonte_financeiro_ativa`: o livro diz "quando disponíveis" sem dizer como saber; o administrador informa se a empresa usa o Financeiro
 * (padrão Ligado). `intervalo_recalculo_horas`: o livro pede recálculo diário enquanto RUNNING; o padrão é 24 h.
 */
const FINANCE_SOURCE_KEY = 'marketing.custos.fonte_financeiro_ativa';
const RECALC_HOURS_KEY = 'marketing.custos.intervalo_recalculo_horas';
const COST_SETTING_DEFAULTS = Object.freeze({ [FINANCE_SOURCE_KEY]: true, [RECALC_HOURS_KEY]: 24 });
const COST_SETTINGS_SCHEMA = { [FINANCE_SOURCE_KEY]: { type: 'boolean' }, [RECALC_HOURS_KEY]: { type: 'integer', min: 1, max: 720 } };

async function read(key, tenant, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service');
  return getSetting(key, tenant, transaction, COST_SETTING_DEFAULTS[key]);
}

async function readFinanceSourceActive(tenant, transaction) {
  const value = await read(FINANCE_SOURCE_KEY, tenant, transaction);
  return value === true || value === 'true';
}

async function readRecalcHours(tenant, transaction) {
  const value = Number(await read(RECALC_HOURS_KEY, tenant, transaction));
  return Number.isInteger(value) && value >= 1 ? value : COST_SETTING_DEFAULTS[RECALC_HOURS_KEY];
}

module.exports = { FINANCE_SOURCE_KEY, RECALC_HOURS_KEY, COST_SETTING_DEFAULTS, COST_SETTINGS_SCHEMA, readFinanceSourceActive, readRecalcHours };
