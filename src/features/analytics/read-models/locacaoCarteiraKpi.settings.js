'use strict';

/**
 * M9-D640 — parâmetros do administrador dos KPIs de contratos ativos, vacância e inadimplência da locação (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.rent.active_contracts | vacancy | delinquency   owner (papel responsável pela reconciliação) de cada indicador
 *   analytics.locacao.faixas_valor_aluguel                          limites, em reais, das faixas de valor do aluguel mensal de "Contratos ativos": "2000,5000,10000" = até 2000, 2001 a 5000,
 *                                                                   5001 a 10000 e acima de 10000 (o livro cita "faixa de valor" sem dizer os limites)
 * A janela da taxa e as faixas de atraso da inadimplência são as do Financeiro (analytics.inadimplencia.janela_dias e analytics.inadimplencia.faixas_atraso_dias, M9-D615 e M9-D622);
 * os tipos de contrato de locação continuam sendo os de analytics.locacao.tipos_contrato (M9-D617). Arquivo sem dependência de settings.service no topo (evita ciclo).
 */
const OWNER = 'Gerência de Locação (papel locação-gestor)';
const CODES = Object.freeze(['rent.active_contracts', 'rent.vacancy', 'rent.delinquency']);
const ownerKey = (code) => `analytics.owner.${code}`;
const RENT_BANDS_KEY = 'analytics.locacao.faixas_valor_aluguel';

const RENTAL_PORTFOLIO_KPI_DEFAULTS = Object.freeze({ ...Object.fromEntries(CODES.map((code) => [ownerKey(code), OWNER])), [RENT_BANDS_KEY]: '2000,5000,10000' });

/** "2000,5000,10000" -> [2000, 5000, 10000]: de 1 a 6 limites inteiros em reais, crescentes, de 1 a 10 milhões. Devolve null se o texto não obedece. */
function parseRentLimits(text) {
  const parts = String(text === undefined || text === null ? '' : text).split(',').map((p) => p.trim());
  if (parts.length < 1 || parts.length > 6 || !parts.every((p) => /^\d{1,8}$/.test(p))) return null;
  const limits = parts.map(Number);
  return limits.every((n, i) => n >= 1 && n <= 10000000 && (i === 0 || n > limits[i - 1])) ? limits : null;
}

function validateRentLimits(key, value) {
  const AppError = require('../../../utils/AppError');
  if (!parseRentLimits(value)) {
    throw AppError.badRequest(`O valor de "${key}" deve ter de 1 a 6 limites crescentes em reais, separados por vírgula (exemplo: 2000,5000,10000).`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

const RENTAL_PORTFOLIO_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), { type: 'string' }])),
  [RENT_BANDS_KEY]: { type: 'string', validate: validateRentLimits },
});

/** Faixas de valor do aluguel da empresa; ausente ou inválido cai no padrão. */
async function readRentBandLimits(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(RENT_BANDS_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, RENTAL_PORTFOLIO_KPI_DEFAULTS[RENT_BANDS_KEY]);
  return parseRentLimits(value) || parseRentLimits(RENTAL_PORTFOLIO_KPI_DEFAULTS[RENT_BANDS_KEY]);
}

/** Owner vigente do KPI na empresa; ausente cai no padrão. */
async function readRentalPortfolioOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(ownerKey(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNER;
}

module.exports = { CODES, RENT_BANDS_KEY, RENTAL_PORTFOLIO_KPI_DEFAULTS, RENTAL_PORTFOLIO_KPI_SETTINGS_SCHEMA, parseRentLimits, readRentBandLimits, readRentalPortfolioOwner };
