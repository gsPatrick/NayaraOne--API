'use strict';

const recommendations = require('../../recommendations');
const { CODE } = require('./juridica.policy');

/**
 * Fechamento M5 (livro §11 "humano valida responsabilidade/cobrança"; JUR-008 "NAY resume/sugere; decisão jurídica é humana"):
 * cada diferença que a NAY aponta entre a vistoria de entrada e a de saída vira uma RECOMENDAÇÃO `ai.ai_recommendations` PENDENTE,
 * dirigida a quem perguntou, sem ação proposta. Aceitar ou rejeitar (POST /v1/ai/recommendations/:id/accept|reject) é a validação
 * humana; aceitar NÃO cria cobrança nem grava nada na vistoria — quem cobra é a pessoa, pelo fluxo da cobrança.
 */
const TYPE = 'INSPECTION_DIFFERENCE';
const REASON = { CONDITION_CHANGED: 'mudou de condição', MISSING_IN_EXIT: 'não consta na vistoria de saída', MISSING_IN_ENTRY: 'não constava na vistoria de entrada' };

async function recordInspectionSuggestions(scope, diff, transaction) {
  const ctx = { groupId: scope.groupId, companyId: scope.companyId, userId: scope.userId };
  const ids = [];
  for (const d of diff.divergences) {
    const { recommendation } = await recommendations.createRecommendation(ctx, {
      agentCode: CODE,
      aiRunId: scope.runId || null,
      relatedEntityType: 'LEGAL_INSPECTION_ITEM', // uma recomendação por item divergente (a chave de duplicidade é por entidade)
      relatedEntityId: d.itemId || diff.exitInspectionId,
      recommendationType: TYPE,
      title: `Vistoria: ${d.itemName} ${REASON[d.reason] || 'divergiu'}`.slice(0, 200),
      rationale: `Entrada: ${d.entryCondition || 'sem registro'}; saída: ${d.exitCondition || 'sem registro'}.${d.damageDescription ? ` Dano: ${d.damageDescription}.` : ''} Avalie a responsabilidade e se cabe cobrança.`,
      confidence: 1,
      riskLevel: 'LOW',
      targetUserId: scope.userId || null,
      payload: { entryInspectionId: diff.entryInspectionId, exitInspectionId: diff.exitInspectionId, divergence: d },
    }, transaction);
    ids.push(recommendation.id);
  }
  return ids;
}

module.exports = { recordInspectionSuggestions, TYPE };
