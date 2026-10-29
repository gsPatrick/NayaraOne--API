'use strict';

// M9-D036 — "toda ação sugerida vira recomendação ou proposta": a sugestão de cobrança ou de renegociação de um título vencido vira uma
// recomendação PENDING em ai.ai_recommendations (D007), sem ação proposta: a pessoa aceita (só marca como vista) ou rejeita. A NAY nunca cobra,
// negocia nem paga. Repetir a consulta no mesmo dia não duplica (a chave de duplicidade da D007).
const { createRecommendation } = require('../../recommendations');
const { CODE } = require('./financeira.policy');

const TYPE = Object.freeze({ COBRANCA: 'COLLECTION_SUGGESTION', RENEGOCIACAO: 'RENEGOTIATION_SUGGESTION' });
const TITLE = Object.freeze({ COBRANCA: 'Cobrar título vencido', RENEGOCIACAO: 'Avaliar renegociação de título vencido' });
const ACTION = Object.freeze({ COBRANCA: 'Cobrar pelo fluxo de cobrança (ação humana).', RENEGOCIACAO: 'Avaliar acordo de cobrança versionado (ação humana).' });

/** Cria uma recomendação por sugestão; sem `runId` (fora do orquestrador) não cria nada. Devolve as recomendações (novas ou já existentes). */
async function recommendCollections({ suggestions, tenant, userId, runId, transaction }) {
  if (!runId) return [];
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId };
  const out = [];
  for (const s of suggestions) {
    const { recommendation } = await createRecommendation(ctx, {
      aiRunId: runId, agentCode: CODE, relatedEntityType: 'FinancialEntry', relatedEntityId: s.financialEntryId, recommendationType: TYPE[s.kind], title: `${TITLE[s.kind]} há ${s.daysOverdue} dia(s)`,
      rationale: `Vencido há ${s.daysOverdue} dia(s); prioridade = valor x log2(dias + 2). ${ACTION[s.kind]}`, riskLevel: 'LOW', payload: { amount: s.amount, daysOverdue: s.daysOverdue, kind: s.kind },
    }, transaction);
    out.push(recommendation);
  }
  return out;
}

module.exports = { recommendCollections, TYPE };
