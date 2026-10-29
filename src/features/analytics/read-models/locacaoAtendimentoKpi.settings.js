'use strict';

/**
 * M9-D642 — parâmetros do administrador dos KPIs de chamados, satisfação e repasses da Locação no BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.<código>   owner (papel responsável pela reconciliação) de rent.tickets, rent.satisfaction e rent.repasses
 * Os demais parâmetros são de outras demandas e valem aqui: tipos de contrato de locação, nota de cada tipo de registro e prazo do repasse (analytics.locacao.*, M9-D617) e a amostra
 * mínima da satisfação (analytics.qualidade.min_amostra, a mesma do funil comercial, do Correspondente e do Atendimento). Arquivo sem dependência de settings.service no topo (evita ciclo).
 */
const { readLocacaoParams } = require('./locacao.settings');
const { readSupportKpiParams } = require('./atendimentoKpi.settings');

const OWNER = 'Gerência de Locação (papel locação-gestor)';
const CODES = Object.freeze(['rent.tickets', 'rent.satisfaction', 'rent.repasses']);
const ownerKey = (code) => `analytics.owner.${code}`;

const RENTAL_CARE_KPI_DEFAULTS = Object.freeze(Object.fromEntries(CODES.map((code) => [ownerKey(code), OWNER])));
const RENTAL_CARE_KPI_SETTINGS_SCHEMA = Object.freeze(Object.fromEntries(CODES.map((code) => [ownerKey(code), { type: 'string' }])));

/** Parâmetros que as fórmulas recebem: a amostra mínima da satisfação (analytics.qualidade.min_amostra) junto dos parâmetros de Locação. */
async function readRentalCareParams(scope, transaction) {
  const [locacao, support] = await Promise.all([readLocacaoParams(scope, transaction), readSupportKpiParams(scope, transaction)]);
  return { ...locacao, minSample: support.minSample };
}

/** Owner vigente do KPI na empresa; ausente cai no padrão. */
async function readRentalCareOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(ownerKey(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNER;
}

module.exports = { CODES, RENTAL_CARE_KPI_DEFAULTS, RENTAL_CARE_KPI_SETTINGS_SCHEMA, readRentalCareParams, readRentalCareOwner };
