'use strict';

/**
 * M9-D624 — parâmetros do administrador dos KPIs de conciliações pendentes e anomalias (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.qualidade.max_idade_extrato_dias         idade máxima, em dias, da última importação de extrato; acima disso o KPI de conciliações sai
 *                                                       DEGRADED sem valor (a pendência pode estar subestimada). Padrão do livro/demanda: 3.
 *   analytics.conciliacao.faixas_idade_dias            limites das faixas de idade da pendência: "2,7" = 0-2, 3-7 e 8+ dias (padrão da demanda).
 *   analytics.owner.fin.reconciliations_pending        owner do KPI de conciliações pendentes (papel responsável).
 *   analytics.owner.fin.anomalies_open                 owner do KPI de anomalias abertas.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const STATEMENT_AGE_KEY = 'analytics.qualidade.max_idade_extrato_dias';
const BANDS_KEY = 'analytics.conciliacao.faixas_idade_dias';
const OWNER_KEYS = Object.freeze({
  'fin.reconciliations_pending': 'analytics.owner.fin.reconciliations_pending',
  'fin.anomalies_open': 'analytics.owner.fin.anomalies_open',
});
const DEFAULT_OWNER = 'Diretoria Financeira (papel financeiro-gestor)';

const FINANCE_KPI_DEFAULTS = Object.freeze({
  [STATEMENT_AGE_KEY]: 3,
  [BANDS_KEY]: '2,7',
  [OWNER_KEYS['fin.reconciliations_pending']]: DEFAULT_OWNER,
  [OWNER_KEYS['fin.anomalies_open']]: DEFAULT_OWNER,
});

/** "2,7" -> [2, 7]: dois limites inteiros, crescentes, de 0 a 3650. Devolve null se o texto não obedece. */
function parseBands(text) {
  const parts = String(text).split(',').map((p) => p.trim());
  if (parts.length !== 2 || !parts.every((p) => /^\d{1,4}$/.test(p))) return null;
  const [a, b] = parts.map(Number);
  return a >= 0 && b > a && b <= 3650 ? [a, b] : null;
}

function validateBands(key, value) {
  const AppError = require('../../../utils/AppError');
  if (!parseBands(value)) {
    throw AppError.badRequest(`O valor de "${key}" deve ter dois limites crescentes em dias, separados por vírgula (exemplo: 2,7).`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

const FINANCE_KPI_SETTINGS_SCHEMA = {
  [STATEMENT_AGE_KEY]: { type: 'integer', min: 1, max: 365 },
  [BANDS_KEY]: { type: 'string', validate: validateBands },
  [OWNER_KEYS['fin.reconciliations_pending']]: { type: 'string' },
  [OWNER_KEYS['fin.anomalies_open']]: { type: 'string' },
};

async function readSetting(key, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  return getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, FINANCE_KPI_DEFAULTS[key]);
}

async function readStatementMaxAgeDays(scope, transaction) {
  const value = Number(await readSetting(STATEMENT_AGE_KEY, scope, transaction));
  return Number.isInteger(value) && value >= 1 && value <= 365 ? value : FINANCE_KPI_DEFAULTS[STATEMENT_AGE_KEY];
}

async function readReconciliationBands(scope, transaction) {
  return parseBands(await readSetting(BANDS_KEY, scope, transaction)) || parseBands(FINANCE_KPI_DEFAULTS[BANDS_KEY]);
}

async function readOwner(metricCode, scope, transaction) {
  const value = await readSetting(OWNER_KEYS[metricCode] || `analytics.owner.${metricCode}`, scope, transaction); // M9-D621/D623: o owner de cada indicador segue o mesmo padrão de chave
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OWNER;
}

module.exports = {
  STATEMENT_AGE_KEY, BANDS_KEY, OWNER_KEYS, FINANCE_KPI_DEFAULTS, FINANCE_KPI_SETTINGS_SCHEMA, parseBands,
  readStatementMaxAgeDays, readReconciliationBands, readOwner,
};
