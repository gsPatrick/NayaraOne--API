'use strict';

// M9-D034 — a sugestão de próxima ação é TEXTO e uma recomendação NEXT_ACTION (risco LOW, sem ação proposta) para quem perguntou. Aceitar
// só a marca como "vista" (D007/D019: recomendação sem ação proposta fecha NOT_APPLICABLE); nenhuma tarefa é criada.
const recommendations = require('../../recommendations');
const { TASKS } = require('./comercial.policy');

const TYPE = 'NEXT_ACTION';
const ENTITY = 'CRM_OPPORTUNITY';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT = new Set(['crmopportunity', 'crm.opportunity', 'opportunity']);

const firstLine = (text) => String(text || '').split('\n')[0].replace(/\s*\[\d+\]/g, '').trim();

function targetOf(state) {
  const meta = state.ruleMeta || {};
  if (meta.recommend === false) return null;
  const subject = state.parsed.subject;
  const id = meta.opportunityId || (subject && SUBJECT.has(String(subject.type).toLowerCase()) ? subject.id : null);
  return UUID.test(String(id || '')) ? String(id) : null;
}

/** Gancho de resposta (agentHooks.checkAnswer): cria a recomendação da sugestão e a devolve em `proposals` do run. O texto não muda. */
async function recommendNextAction(state, text) {
  if (state.parsed.taskType !== TASKS.NEXT_ACTION) return text;
  const opportunityId = targetOf(state);
  if (!opportunityId) return text;
  const meta = state.ruleMeta || {};
  const { recommendation } = await recommendations.createRecommendation(state.ctx, {
    agentCode: state.agent.code, aiRunId: state.runId, relatedEntityType: ENTITY, relatedEntityId: opportunityId, recommendationType: TYPE,
    title: (meta.title || firstLine(text) || 'Próxima ação sugerida').slice(0, 200), rationale: meta.rationale || firstLine(text), riskLevel: 'LOW',
    targetUserId: state.ctx.userId || null, payload: { rule: meta.rule || null, matched: meta.matched || [], source: meta.rule ? 'RULE' : 'MODEL' },
  }, state.transaction);
  if (!state.proposals.some((p) => p.id === recommendation.id)) state.proposals.push({ id: recommendation.id, kind: TYPE, status: recommendation.status });
  return text;
}

module.exports = { recommendNextAction, TYPE, ENTITY };
