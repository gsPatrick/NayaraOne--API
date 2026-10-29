'use strict';

/**
 * M9-D652 — definição, no Metric Registry, dos três KPIs de desperdício, custo pós-obra e recorrência. Os 15 campos do livro (M9-D603): fonte (read model de
 * Obras da M9-D618 e o das ocorrências), fórmula versionada no código (formulas/obra*.js, id = código do indicador), dimensões, unidade, owner (parâmetro
 * analytics.owner.<código>), política de atualização, natureza e regra de qualidade, como escritos na demanda. Versão 1. Criticidade, natureza, unidade, dimensões,
 * política de atualização e owner padrão saem da tabela da M9-D712 (dona deles), nunca repetidos aqui. obra.waste e obra.postwork_cost são CRITICAL: nascem com
 * drill-down. Os nomes dos read models aparecem só em models.js; a leitura SQL mora em sources.js.
 */
const { getCriticalityRow } = require('../../seed/criticality.table');
const { readObraCostOwner, OBRA_COST_KPI_CODES } = require('../../../read-models/obraPerdasKpi.settings');

const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Obras (M9-D708): desperdício, custo pós-obra e recorrência conforme os módulos de Estoque e Obras';

const TEXT = {
  'obra.waste': {
    description: 'Onde se perde material nas obras: custo das baixas de perda, por obra e material, e quanto isso pesa sobre o consumo valorizado da obra.',
    formulaSemantic: 'Σ (quantidade baixada por perda × custo médio do dia da baixa, gravado no movimento) das obras até a data-base, por obra e material; % = desperdício ÷ consumo valorizado (saídas) × 100, 2 casas; consumo zero → INCOMPLETE; baixa de perda sem custo médio → DEGRADED. Posição, decimal exato, arredondado uma só vez.',
    qualityRule: { requiredFields: ['waste_value', 'consumption_value'], allowNull: false, incompleteWhen: 'consumo zero', degradedWhen: 'movimento de perda sem custo médio' },
  },
  'obra.postwork_cost': {
    description: 'Quanto a garantia custa depois da entrega: custo dos casos de garantia já encerrados, com o previsto (casos abertos) à parte, e o peso sobre a receita contratada das obras.',
    formulaSemantic: 'Σ custo (mão de obra e material do caso + custo de cada ação de garantia) dos casos ENCERRADOS de obras; previsto = mesmo custo dos casos ainda abertos, em separado; % = realizado ÷ receita contratada das obras com caso × 100, 2 casas; caso sem obra vinculada → DEGRADED.',
    qualityRule: { requiredFields: ['warranty_cost', 'warranty_cost_open'], allowNull: false, degradedWhen: 'ocorrência sem obra vinculada' },
  },
  'obra.recurrence': {
    description: 'O que se repete nas obras: combinações de causa, equipe ou material com 2 ou mais ocorrências nos últimos 180 dias, em ranking das maiores.',
    formulaSemantic: 'Combinação (causa, equipe ou material) com analytics.obra.recorrencia_min_ocorrencias ou mais ocorrências distintas (não conformidades e casos de garantia de obras) nos últimos analytics.obra.recorrencia_dias dias até a data-base; valor = combinações recorrentes; ranking das analytics.obra.recorrencia_top maiores por contagem, custo e chave, com obras afetadas e custo; ocorrência sem classificação fica fora e é contada em details.unclassified.',
    qualityRule: { requiredFields: ['cause', 'teams', 'materials'], allowNull: false, unclassified: 'details.unclassified' },
  },
};

function definitionOf(code) {
  const row = getCriticalityRow(code);
  const text = TEXT[code];
  return {
    metricCode: code, name: row.name, description: text.description, formulaId: code, formulaSemantic: text.formulaSemantic, sourceReadModel: row.sourceReadModel,
    unit: row.unit, criticality: row.criticality, drilldownEnabled: row.criticality === 'CRITICAL', valueNature: row.valueNature, dimensions: [...row.dimensions],
    refreshPolicy: { ...row.refreshPolicy }, qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: row.refreshPolicy.maxStalenessMinutes, ...text.qualityRule },
  };
}

const KPI_DEFINITIONS = Object.freeze(OBRA_COST_KPI_CODES.map((code) => Object.freeze(definitionOf(code))));

/** Entrada completa de `publishMetric` (escopo da empresa, para o owner seguir o parâmetro de cada empresa). */
async function publishInput(def, scope, transaction) {
  return { ...def, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', ownerRole: await readObraCostOwner(def.metricCode, scope, transaction) };
}

module.exports = { KPI_DEFINITIONS, publishInput };
