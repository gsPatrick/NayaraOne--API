'use strict';

/**
 * M9-D653 — parâmetros do administrador dos KPIs de Estoque e Patrimônio (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.inv.stock_value | below_minimum | losses | tools_overdue   owner (papel responsável pela reconciliação) de cada KPI
 * Os tipos de item que entram no valor em estoque e nas rupturas são o parâmetro analytics.estoque.tipos_item (M9-D618).
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const DEFAULT_OWNER = 'Almoxarifado (papel estoque-gestor)';
const INV_KPI_CODES = Object.freeze(['inv.stock_value', 'inv.below_minimum', 'inv.losses', 'inv.tools_overdue']);
const OWNER_KEY = (code) => `analytics.owner.${code}`;

const INV_KPI_DEFAULTS = Object.freeze(Object.fromEntries(INV_KPI_CODES.map((code) => [OWNER_KEY(code), DEFAULT_OWNER])));
const INV_KPI_SETTINGS_SCHEMA = Object.freeze(Object.fromEntries(INV_KPI_CODES.map((code) => [OWNER_KEY(code), { type: 'string' }])));

async function readInventoryOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(OWNER_KEY(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, DEFAULT_OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OWNER;
}

module.exports = { INV_KPI_CODES, INV_KPI_DEFAULTS, INV_KPI_SETTINGS_SCHEMA, DEFAULT_OWNER, readInventoryOwner };
