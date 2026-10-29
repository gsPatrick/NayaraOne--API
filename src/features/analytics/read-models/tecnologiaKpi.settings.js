'use strict';

/**
 * M9-D680 — parâmetros do administrador dos KPIs de Tecnologia do BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.tec.janela_minutos                janela, em minutos, da taxa de erro das integrações (padrão 60 = última hora; usa as janelas que o health grava: 5, 60, 1440)
 *   analytics.tec.auth_falhas_por_hora          limiar de falhas de autenticação por hora acima do qual o pico gera alerta (padrão 20)
 *   analytics.tec.sondas_ausentes_max_pct       acima deste percentual de sondas ausentes a disponibilidade fica DEGRADED (padrão 5)
 *   analytics.tec.fila_sem_medicao_min          fila sem medição há mais de N minutos fica STALE (padrão 15)
 *   analytics.tec.motivos_bloqueio_conhecidos   motivos de bloqueio que têm linha própria; os outros somam em details.other
 *   analytics.owner.tec.<código>                owner (papel responsável pela reconciliação) de cada KPI de Tecnologia
 * Os parâmetros dos read models (M9-D628) ficam em tecnologia.settings.js. Arquivo sem dependência de settings.service no topo (evita ciclo).
 */
const { codeList, readCodeList } = require('./settings.codeList');

const OWNER = 'Tecnologia (papel ti-gestor)';
const CODES = Object.freeze(['tec.availability', 'tec.queues_dlq', 'tec.integration_errors', 'tec.freshness', 'tec.auth_failures', 'tec.blocked_events']);
const ownerKey = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({
  windowMinutes: 'analytics.tec.janela_minutos',
  authPerHour: 'analytics.tec.auth_falhas_por_hora',
  missingProbesMaxPct: 'analytics.tec.sondas_ausentes_max_pct',
  queueStaleMinutes: 'analytics.tec.fila_sem_medicao_min',
  knownBlockReasons: 'analytics.tec.motivos_bloqueio_conhecidos',
});

const TECH_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), OWNER])),
  [KEYS.windowMinutes]: 60, [KEYS.authPerHour]: 20, [KEYS.missingProbesMaxPct]: 5, [KEYS.queueStaleMinutes]: 15, [KEYS.knownBlockReasons]: 'KILL_SWITCH,SECURITY_POLICY,CONSENT,VALIDATION',
});

const TECH_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), { type: 'string' }])),
  [KEYS.windowMinutes]: { type: 'integer', min: 1, max: 10080 },
  [KEYS.authPerHour]: { type: 'integer', min: 1, max: 100000 },
  [KEYS.missingProbesMaxPct]: { type: 'integer', min: 0, max: 100 },
  [KEYS.queueStaleMinutes]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.knownBlockReasons]: { type: 'string', validate: codeList },
});

const positiveInt = (v, fallback) => (Number.isInteger(v) && v >= 1 ? v : fallback);

/** Parâmetros dos KPIs vigentes da empresa; ausente ou inválido cai no padrão. */
async function readTechKpiParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const ctx = { companyId: scope.companyId, groupId: scope.groupId };
  const int = async (key) => positiveInt(await getSetting(key, ctx, transaction, TECH_KPI_DEFAULTS[key]), TECH_KPI_DEFAULTS[key]);
  const pct = await getSetting(KEYS.missingProbesMaxPct, ctx, transaction, TECH_KPI_DEFAULTS[KEYS.missingProbesMaxPct]);
  return {
    windowMinutes: await int(KEYS.windowMinutes),
    authPerHour: await int(KEYS.authPerHour),
    queueStaleMinutes: await int(KEYS.queueStaleMinutes),
    missingProbesMaxPct: Number.isInteger(pct) && pct >= 0 && pct <= 100 ? pct : TECH_KPI_DEFAULTS[KEYS.missingProbesMaxPct],
    knownBlockReasons: await readCodeList(KEYS.knownBlockReasons, TECH_KPI_DEFAULTS[KEYS.knownBlockReasons], scope, transaction),
  };
}

/** Owner vigente do KPI na empresa; ausente cai no padrão. */
async function readTechOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(ownerKey(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNER;
}

module.exports = { CODES, KEYS, OWNER, TECH_KPI_DEFAULTS, TECH_KPI_SETTINGS_SCHEMA, readTechKpiParams, readTechOwner };
