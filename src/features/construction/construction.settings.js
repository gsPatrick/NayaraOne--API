'use strict';

const AppError = require('../../utils/AppError');

/**
 * Parâmetros de Obras que o administrador grava em Obras → Configurações (verificação independente do Marco 6). Regra
 * do Patrick: o que o livro não resolve vira parâmetro; padrão = valor do livro, senão o comportamento que o código já
 * tinha, senão o mais conservador. Entram no SETTINGS_SCHEMA do serviço de parâmetros (tipo e faixa conferidos antes de
 * gravar; auditoria settings.create/settings.update com antes e depois; permissão construction:approve em
 * settingRestricted.js). Os padrões abaixo são o catálogo (Maturacao/demandas/parametros.csv) — o valor vigente é o da
 * empresa.
 *
 *  - construction.medicao.evidencias_minimas (M6-21, Guia §6 "approveMeasurement(): ... evidências"): quantos arquivos de
 *    evidência a medição precisa ter para ser aprovada. O livro manda conferir as evidências na aprovação (sempre
 *    feito: todo arquivo anexado é conferido) mas não fixa um mínimo; padrão 0 = comportamento anterior (DI-M6V-5).
 *  - construction.diario_ausente.* (M6-108, Caderno §6 "ausência de diário gera tarefa conforme regra"): se a regra está
 *    ligada, quais situações de obra exigem diário, em que dias da semana (0 = domingo … 6 = sábado), se os feriados do
 *    calendário (governanca.calendario.feriados) contam, a prioridade da tarefa e a janela/prioridade da tarefa de
 *    documentação do prestador. Padrões = o que o job fazia (obra ACTIVE, segunda a sexta, sem feriado, HIGH, 7 dias,
 *    MEDIUM).
 */
const PROJECT_STATUSES = ['PLANNED', 'BUDGETED', 'READY', 'ACTIVE', 'PAUSED', 'FINAL_INSPECTION'];
const TASK_PRIORITIES = ['LOW', 'NORMAL', 'MEDIUM', 'HIGH', 'URGENT'];

const KEYS = Object.freeze({
  measurementMinEvidence: 'construction.medicao.evidencias_minimas',
  missingReportEnabled: 'construction.diario_ausente.ativo',
  missingReportStatuses: 'construction.diario_ausente.status_obra',
  missingReportWeekdays: 'construction.diario_ausente.dias_semana',
  missingReportHolidays: 'construction.diario_ausente.considerar_feriados',
  missingReportPriority: 'construction.diario_ausente.prioridade_tarefa',
  missingDocsEnabled: 'construction.diario_ausente.documentos_ativo',
  missingDocsWindowDays: 'construction.diario_ausente.documentos_janela_dias',
  missingDocsPriority: 'construction.diario_ausente.documentos_prioridade',
});

const DEFAULTS = Object.freeze({
  [KEYS.measurementMinEvidence]: 0,
  [KEYS.missingReportEnabled]: true,
  [KEYS.missingReportStatuses]: 'ACTIVE',
  [KEYS.missingReportWeekdays]: '1,2,3,4,5',
  [KEYS.missingReportHolidays]: false,
  [KEYS.missingReportPriority]: 'HIGH',
  [KEYS.missingDocsEnabled]: true,
  [KEYS.missingDocsWindowDays]: 7,
  [KEYS.missingDocsPriority]: 'MEDIUM',
});

function listOf(text) {
  return String(text || '').split(',').map((v) => v.trim()).filter(Boolean);
}

function validateList(allowed, label) {
  return (key, value) => {
    const items = listOf(value);
    if (!items.length || items.some((v) => !allowed.includes(v)) || new Set(items).size !== items.length) {
      throw AppError.badRequest(`O valor de "${key}" deve ser uma lista separada por vírgula de: ${allowed.join(', ')} (${label}).`, 'SETTING_INVALID_VALUE', { key, value });
    }
  };
}

const CONSTRUCTION_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.measurementMinEvidence]: { type: 'integer', min: 0, max: 20 },
  [KEYS.missingReportEnabled]: { type: 'boolean' },
  [KEYS.missingReportStatuses]: { type: 'string', validate: validateList(PROJECT_STATUSES, 'situações da obra') },
  [KEYS.missingReportWeekdays]: { type: 'string', validate: validateList(['0', '1', '2', '3', '4', '5', '6'], '0 = domingo … 6 = sábado') },
  [KEYS.missingReportHolidays]: { type: 'boolean' },
  [KEYS.missingReportPriority]: { type: 'string', enum: TASK_PRIORITIES },
  [KEYS.missingDocsEnabled]: { type: 'boolean' },
  [KEYS.missingDocsWindowDays]: { type: 'integer', min: 1, max: 90 },
  [KEYS.missingDocsPriority]: { type: 'string', enum: TASK_PRIORITIES },
});

/** Valor vigente da empresa (ou o padrão do catálogo). */
async function getConstructionSetting(key, tenant, transaction) {
  const { getSetting } = require('../settings/settings.service'); // tardio: o serviço de parâmetros importa este catálogo
  const value = await getSetting(key, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction, DEFAULTS[key]);
  return value === null || value === undefined ? DEFAULTS[key] : value;
}

/** Todos os parâmetros de Obras de uma vez (tela de configurações e job). */
async function getConstructionSettings(tenant, transaction) {
  const out = {};
  for (const key of Object.values(KEYS)) out[key] = await getConstructionSetting(key, tenant, transaction);
  return out;
}

module.exports = { KEYS, DEFAULTS, CONSTRUCTION_SETTINGS_SCHEMA, PROJECT_STATUSES, TASK_PRIORITIES, listOf, getConstructionSetting, getConstructionSettings };
