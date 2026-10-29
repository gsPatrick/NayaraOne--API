'use strict';

const recommendations = require('../../recommendations');
const { CODE } = require('./definition');

/**
 * Toda ação sugerida pela NAY Documental vira RECOMENDAÇÃO (M9-D040, D007): a classificação e a extração propostas ficam numa linha
 * `ai.ai_recommendations` PENDING, dirigida a quem perguntou, para uma pessoa aceitar (marcar como vista) ou rejeitar. Aceitar NÃO grava
 * nada no cadastro: quem grava é a pessoa, pelas telas do módulo dono. A mesma sugestão pendente no mesmo dia devolve a existente.
 */
async function recordSuggestion(scope, { type, fileId, title, rationale, confidence, payload }, transaction) {
  const ctx = { groupId: scope.groupId, companyId: scope.companyId, userId: scope.userId };
  const { recommendation } = await recommendations.createRecommendation(ctx, {
    agentCode: CODE, aiRunId: scope.runId || null, relatedEntityType: 'FILE', relatedEntityId: fileId, recommendationType: type, title, rationale,
    confidence, riskLevel: 'LOW', targetUserId: scope.userId || null, payload,
  }, transaction);
  return recommendation.id;
}

const TYPES = Object.freeze({ extraction: 'DOCUMENT_EXTRACTION', classification: 'DOCUMENT_CLASSIFICATION' });

module.exports = { recordSuggestion, TYPES };
