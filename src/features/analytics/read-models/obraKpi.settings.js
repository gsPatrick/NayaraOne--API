'use strict';

/**
 * M9-D650 — parâmetros do administrador dos KPIs de Obras de avanço, custo e margem (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.obra.<código>   owner (papel responsável pela reconciliação) de progress_vs_schedule, baseline_actual_forecast e projected_margin;
 *                                   padrão do livro: Diretoria de Obras (papel obras-gestor). Lido na publicação do indicador.
 * `readObraOwner` serve também aos KPIs de atrasos, medições e não conformidades (M9-D651, obraOperacaoKpi.settings.js) e aos de desperdício, custo
 * pós-obra e recorrência (M9-D652, obraPerdasKpi.settings.js): a chave é sempre analytics.owner.<código>. As fórmulas e os estados dos indicadores são do
 * livro e não são parâmetro. Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const OBRA_KPI_CODES = Object.freeze(['obra.progress_vs_schedule', 'obra.baseline_actual_forecast', 'obra.projected_margin']);
const DEFAULT_OWNER = 'Diretoria de Obras (papel obras-gestor)';

const ownerKey = (code) => `analytics.owner.${code}`;
const OBRA_KPI_DEFAULTS = Object.freeze(Object.fromEntries(OBRA_KPI_CODES.map((code) => [ownerKey(code), DEFAULT_OWNER])));
const OBRA_KPI_SETTINGS_SCHEMA = Object.freeze(Object.fromEntries(OBRA_KPI_CODES.map((code) => [ownerKey(code), { type: 'string' }])));

async function readObraOwner(code, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(ownerKey(code), { companyId: scope.companyId, groupId: scope.groupId }, transaction, DEFAULT_OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OWNER;
}

module.exports = { OBRA_KPI_CODES, DEFAULT_OWNER, OBRA_KPI_DEFAULTS, OBRA_KPI_SETTINGS_SCHEMA, readObraOwner };
