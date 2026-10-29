'use strict';

/**
 * M9-D623 — parâmetros do administrador dos KPIs de margem por setor, comissões provisionadas e pagas e repasses pendentes ao proprietário
 * (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.qualidade.max_sem_setor_pct       parte máxima, em %, do movimento do mês sem centro de resultado; acima disso a margem por setor sai
 *                                               DEGRADED e sem valor. Padrão da demanda: 1.
 *   analytics.repasse.dias_alerta               dias úteis (helper do projeto, M9-D606) desde a geração do repasse a partir dos quais ele é exposto em
 *                                               details.overdueBeyondAlert e destacado no Centro de Comando. Padrão da demanda: 5.
 *   analytics.repasse.faixas_atraso_dias        limites das faixas de atraso, em dias úteis: "5,15" = 0-5, 6-15 e 16+ (padrão da DI-D623-5).
 *   analytics.owner.fin.<código>                owner de cada um dos quatro indicadores.
 * Arquivo sem dependência no topo (evita ciclo com settings.service; a leitura usa import tardio).
 */
const { parseBands } = require('./financeKpi.settings');

const RESULT_CODES = Object.freeze(['fin.sector_margin', 'fin.commissions_provisioned', 'fin.commissions_paid', 'fin.owner_repasses_pending']);
const SECTOR_KEY = 'analytics.qualidade.max_sem_setor_pct';
const ALERT_KEY = 'analytics.repasse.dias_alerta';
const BANDS_KEY = 'analytics.repasse.faixas_atraso_dias';
const DEFAULT_OWNER = 'Diretoria Financeira (papel financeiro-gestor)';

const FINANCE_RESULT_DEFAULTS = Object.freeze({
  [SECTOR_KEY]: 1, [ALERT_KEY]: 5, [BANDS_KEY]: '5,15',
  ...Object.fromEntries(RESULT_CODES.map((code) => [`analytics.owner.${code}`, DEFAULT_OWNER])),
});

function validateBands(key, value) {
  const AppError = require('../../../utils/AppError');
  if (!parseBands(value)) {
    throw AppError.badRequest(`O valor de "${key}" deve ter dois limites crescentes em dias úteis, separados por vírgula (exemplo: 5,15).`, 'SETTING_INVALID_VALUE', { key, value });
  }
}

const FINANCE_RESULT_SETTINGS_SCHEMA = Object.freeze({
  [SECTOR_KEY]: { type: 'number', min: 0, max: 100 },
  [ALERT_KEY]: { type: 'integer', min: 1, max: 90 },
  [BANDS_KEY]: { type: 'string', validate: validateBands },
  ...Object.fromEntries(RESULT_CODES.map((code) => [`analytics.owner.${code}`, { type: 'string' }])),
});

async function readSetting(key, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  return getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, FINANCE_RESULT_DEFAULTS[key]);
}

/** { maxNoSectorPct, alertBusinessDays, bands } da empresa; valor fora da faixa cai no padrão da demanda. */
async function readResultParams(scope, transaction) {
  const max = Number(await readSetting(SECTOR_KEY, scope, transaction));
  const alert = Number(await readSetting(ALERT_KEY, scope, transaction));
  return {
    maxNoSectorPct: Number.isFinite(max) && max >= 0 && max <= 100 ? String(max) : String(FINANCE_RESULT_DEFAULTS[SECTOR_KEY]),
    alertBusinessDays: Number.isInteger(alert) && alert >= 1 && alert <= 90 ? alert : FINANCE_RESULT_DEFAULTS[ALERT_KEY],
    bands: parseBands(await readSetting(BANDS_KEY, scope, transaction)) || parseBands(FINANCE_RESULT_DEFAULTS[BANDS_KEY]),
  };
}

module.exports = { RESULT_CODES, SECTOR_KEY, ALERT_KEY, BANDS_KEY, FINANCE_RESULT_DEFAULTS, FINANCE_RESULT_SETTINGS_SCHEMA, readResultParams };
