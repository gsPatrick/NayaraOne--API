'use strict';

/**
 * M9-D709 — definição, no Metric Registry, dos quatro KPIs da fila de decisão do Centro de Comando. Os 15 campos do livro (M9-D603): fonte (rm_decision_queue),
 * fórmula versionada no código (formulas/*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de
 * atualização, natureza e regra de qualidade, como escritos na demanda. Versão 1. Criticidade, natureza, unidade, dimensões, política de atualização e owner
 * padrão saem da tabela da M9-D712 (dona deles). Os quatro são CRITICAL: nascem com drill-down.
 */
const { getCriticalityRow } = require('../../seed/criticality.table');
const { readQueueOwner, QUEUE_KPI_CODES } = require('../../../read-models/decisaoFilaKpi.settings');

const REFERENCE_REPORT = 'Relatório de conciliação das filas de decisão (M9-D708): aprovações financeiras, ajustes de estoque, aprovações de regra e propostas da NAY conforme os módulos de origem';

const TEXT = {
  'fin.approvals_pending': {
    description: 'Quantas aprovações do Financeiro esperam decisão e quanto dinheiro está parado nelas, com as envelhecidas.',
    formulaSemantic: 'Contagem das aprovações financeiras abertas na data-base e soma do valor envolvido (BRL) das que têm valor; idade = data-base − data do pedido, em horas; envelhecida acima de analytics.centro.decisao_atraso_horas; aprovação aberta sem data do pedido → INCOMPLETE.',
    qualityRule: { requiredFields: ['requested_at'], allowNull: false, incompleteWhen: 'aprovação aberta sem data do pedido' },
  },
  'inv.adjustments_pending': {
    description: 'Quantas propostas de ajuste de estoque esperam decisão e o valor delas em módulo.',
    formulaSemantic: 'Contagem das propostas pendentes e soma do valor do ajuste em módulo (BRL, |quantidade| × custo médio); por depósito e motivo; proposta sem item ou sem quantidade → INCOMPLETE.',
    qualityRule: { requiredFields: ['item_id', 'quantity'], allowNull: false, incompleteWhen: 'proposta sem item ou sem quantidade' },
  },
  'tec.rule_approvals_pending': {
    description: 'Quantos pedidos de publicação de regra esperam aprovação.',
    formulaSemantic: 'Contagem dos pedidos de publicação de regra aguardando aprovação, por regra e solicitante; pedido sem regra vinculada → INCOMPLETE.',
    qualityRule: { requiredFields: ['rule_id'], allowNull: false, incompleteWhen: 'pedido sem regra vinculada' },
  },
  'ai.proposals_pending': {
    description: 'Quantas propostas da NAY esperam aprovação humana (só as que têm ação proposta; recomendação informativa não é aprovação).',
    formulaSemantic: 'Contagem das propostas pendentes (ai.ai_recommendations com proposed_action), por agente e tipo; idade em horas; proposta sem run_id ou sem fontes → INCOMPLETE.',
    qualityRule: { requiredFields: ['run_id', 'has_sources'], allowNull: false, incompleteWhen: 'proposta sem run_id ou sem fontes' },
  },
};

function definitionOf(code) {
  const row = getCriticalityRow(code);
  const text = TEXT[code];
  return {
    metricCode: code, name: row.name, domain: row.domain, description: text.description, formulaId: code, formulaSemantic: text.formulaSemantic, sourceReadModel: row.sourceReadModel,
    unit: row.unit, criticality: row.criticality, drilldownEnabled: row.criticality === 'CRITICAL', valueNature: row.valueNature, dimensions: [...row.dimensions],
    refreshPolicy: { ...row.refreshPolicy }, qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: row.refreshPolicy.maxStalenessMinutes, ...text.qualityRule },
  };
}

const KPI_DEFINITIONS = Object.freeze(QUEUE_KPI_CODES.map((code) => Object.freeze(definitionOf(code))));

/** Entrada completa de `publishMetric` (escopo da empresa, para o owner seguir o parâmetro de cada empresa). */
async function publishInput(def, scope, transaction) {
  return { ...def, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', ownerRole: await readQueueOwner(def.metricCode, scope, transaction) };
}

module.exports = { KPI_DEFINITIONS, publishInput };
