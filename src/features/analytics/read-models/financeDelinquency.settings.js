'use strict';

/**
 * M9-D622 — parâmetros do administrador dos KPIs de inadimplência (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.inadimplencia.faixas_atraso_dias   limites, em dias de atraso, das faixas do valor inadimplente: "30,60,90" = 1-30, 31-60, 61-90 e 90+ (padrão do livro).
 *   analytics.owner.fin.overdue_receivables      owner do valor inadimplente (papel responsável pela reconciliação).
 *   analytics.owner.fin.delinquency_rate         owner da taxa de inadimplência.
 *   analytics.owner.fin.breathing_need           owner da necessidade para respirar.
 * A janela da taxa continua sendo analytics.inadimplencia.janela_dias (M9-D615, padrão 90). Arquivo sem dependência no topo (evita ciclo com settings.service).
 */
const CODES = Object.freeze(['fin.overdue_receivables', 'fin.delinquency_rate', 'fin.breathing_need']);
const BANDS_KEY = 'analytics.inadimplencia.faixas_atraso_dias';
const DEFAULT_OWNER = 'Diretoria Financeira (papel financeiro-gestor)';
const ownerKey = (code) => `analytics.owner.${code}`;

const FINANCE_DELINQUENCY_DEFAULTS = Object.freeze({ [BANDS_KEY]: '30,60,90', ...Object.fromEntries(CODES.map((code) => [ownerKey(code), DEFAULT_OWNER])) });

/** "30,60,90" -> [30, 60, 90]: de 1 a 6 limites inteiros, crescentes, de 1 a 3650. Devolve null se o texto não obedece. */
function parseLimits(text) {
  const parts = String(text === undefined || text === null ? '' : text).split(',').map((p) => p.trim());
  if (parts.length < 1 || parts.length > 6 || !parts.every((p) => /^\d{1,4}$/.test(p))) return null;
  const limits = parts.map(Number);
  return limits.every((n, i) => n >= 1 && n <= 3650 && (i === 0 || n > limits[i - 1])) ? limits : null;
}

function validateLimits(key, value) {
  const AppError = require('../../../utils/AppError');
  if (!parseLimits(value)) {
    throw AppError.badRequest(`O valor de "${key}" deve ter de 1 a 6 limites crescentes em dias de atraso, separados por vírgula (exemplo: 30,60,90).`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

const FINANCE_DELINQUENCY_SETTINGS_SCHEMA = Object.freeze({
  [BANDS_KEY]: { type: 'string', validate: validateLimits },
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), { type: 'string' }])),
});

/** Limites das faixas de atraso da empresa; ausente ou inválido cai no padrão do livro. */
async function readOverdueBandLimits(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(BANDS_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, FINANCE_DELINQUENCY_DEFAULTS[BANDS_KEY]);
  return parseLimits(value) || parseLimits(FINANCE_DELINQUENCY_DEFAULTS[BANDS_KEY]);
}

module.exports = { CODES, BANDS_KEY, FINANCE_DELINQUENCY_DEFAULTS, FINANCE_DELINQUENCY_SETTINGS_SCHEMA, parseLimits, readOverdueBandLimits };
