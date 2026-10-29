'use strict';

/**
 * M9-D653 — definição, no Metric Registry, dos quatro KPIs de Estoque e Patrimônio. Os 15 campos do livro (M9-D603): fonte (rm_inventory_health e
 * rm_tool_assets), fórmula versionada no código (formulas/inv*.js, id = código do indicador), dimensões, unidade, owner (parâmetro
 * analytics.owner.<código>), política de atualização, natureza e regra de qualidade, como escritos na demanda. Versão 1. Criticidade, natureza, unidade,
 * dimensões, política de atualização e owner padrão saem da tabela da M9-D712 (dona deles). inv.losses é CRITICAL: nasce com drill-down.
 */
const { getCriticalityRow } = require('../../seed/criticality.table');
const { readInventoryOwner, INV_KPI_CODES } = require('../../../read-models/estoqueKpi.settings');

const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Estoque e Patrimônio (M9-D708): saldo valorizado, mínimos, perdas e ferramentas conforme o módulo de Estoque';

const TEXT = {
  'inv.stock_value': {
    description: 'Quanto vale o estoque: Σ (saldo × custo médio ponderado) dos itens ativos dos tipos configurados, na data-base.',
    formulaSemantic: 'Σ (quantidade em saldo × custo médio ponderado) de todos os itens e locais da empresa na data-base, arredondado uma só vez em 2 casas; item com saldo e sem custo médio → DEGRADED.',
    qualityRule: { requiredFields: ['stock_value', 'items_without_cost'], allowNull: false, degradedWhen: 'item com saldo e sem custo médio' },
  },
  'inv.below_minimum': {
    description: 'Quantos itens estão abaixo do estoque mínimo e quantos em ruptura (saldo zero), na data-base.',
    formulaSemantic: 'Contagem de itens ativos com saldo total < estoque mínimo, com as rupturas (mínimo definido e saldo ≤ 0) em dimensão própria; item sem mínimo fica fora e é contado em details.noMinimum; qualquer item ativo sem mínimo → DEGRADED.',
    qualityRule: { requiredFields: ['items_below_min', 'items_without_min'], allowNull: false, degradedWhen: 'item ativo sem estoque mínimo' },
  },
  'inv.losses': {
    description: 'Quanto se perdeu em estoque: valor das perdas decididas como perda na janela de dias definida pelo administrador (padrão 30), com a quantidade de perdas e os casos ainda abertos.',
    formulaSemantic: 'Σ valor dos casos de perda decididos como perda (APPROVED) nos dias da janela (padrão 30) até a data-base, pelo custo do movimento de baixa ou o estimado; casos abertos e quantidade de perdas em separado; perda decidida sem valor → DEGRADED.',
    qualityRule: { requiredFields: ['losses_30d', 'losses_without_value'], allowNull: false, degradedWhen: 'perda decidida sem valor' },
  },
  'inv.tools_overdue': {
    description: 'Ferramentas que deveriam ter voltado e não voltaram: empréstimos abertos com devolução prevista vencida, os abertos e os ativos em manutenção.',
    formulaSemantic: 'Contagem de empréstimos abertos com devolução prevista < data-base (calendário de São Paulo), de empréstimos abertos e de ativos com ordem de manutenção aberta; a lista vai ao drill-down; empréstimo sem data prevista → DEGRADED.',
    qualityRule: { requiredFields: ['loans_overdue', 'loans_without_due_date'], allowNull: false, degradedWhen: 'empréstimo sem data prevista' },
    drilldown: true, // a lista de quem está com o quê vai ao drill-down (M9-D653), mesmo sendo NORMAL na tabela de criticidade
  },
};

function definitionOf(code) {
  const row = getCriticalityRow(code);
  const text = TEXT[code];
  return {
    metricCode: code, name: row.name, description: text.description, formulaId: code, formulaSemantic: text.formulaSemantic, sourceReadModel: row.sourceReadModel,
    unit: row.unit, criticality: row.criticality, drilldownEnabled: row.criticality === 'CRITICAL' || text.drilldown === true, valueNature: row.valueNature, dimensions: [...row.dimensions],
    refreshPolicy: { ...row.refreshPolicy }, qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: row.refreshPolicy.maxStalenessMinutes, ...text.qualityRule },
  };
}

const KPI_DEFINITIONS = Object.freeze(INV_KPI_CODES.map((code) => Object.freeze(definitionOf(code))));

/** Entrada completa de `publishMetric` (escopo da empresa, para o owner seguir o parâmetro de cada empresa). */
async function publishInput(def, scope, transaction) {
  return { ...def, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', ownerRole: await readInventoryOwner(def.metricCode, scope, transaction) };
}

module.exports = { KPI_DEFINITIONS, publishInput };
