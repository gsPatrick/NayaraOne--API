'use strict';

// M9-D034 — a sugestão de próxima ação é TEXTO e uma recomendação NEXT_ACTION (risco LOW, sem ação proposta) para quem perguntou. Aceitar
// só a marca como "vista" (D007/D019: recomendação sem ação proposta fecha NOT_APPLICABLE); nenhuma tarefa é criada.
// Livro do Marco 3 §12/§16: o resumo de mensagem recebida (apoio) e a proposta de envio de mensagem também viram recomendação para quem
// pediu, sem ação executável. A recomendação é montada do resultado do caminho de regra (`ruleMeta.recommendation`) ou, no caminho de
// modelo do resumo de mensagem, do texto final já revisado (sem atributo sensível).
const recommendations = require('../../recommendations');
const { TASKS } = require('./comercial.policy');
const { recall } = require('./comercial.runStore');
const { messageRecommendation } = require('./comercial.messageSummary');
const { MENSAGEM_INSUFICIENCIA } = require('../../orchestrator/grounding/grounding.constants');

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

async function save(state, rec) {
  const { recommendation } = await recommendations.createRecommendation(state.ctx, {
    agentCode: state.agent.code, aiRunId: state.runId, relatedEntityType: rec.entityType, relatedEntityId: rec.entityId, recommendationType: rec.type,
    title: rec.title, rationale: rec.rationale, riskLevel: rec.riskLevel, targetUserId: state.ctx.userId || null, payload: rec.payload,
  }, state.transaction);
  if (!state.proposals.some((p) => p.id === recommendation.id)) state.proposals.push({ id: recommendation.id, kind: rec.type, status: recommendation.status });
}

/** Resumo de mensagem pelo modelo: a recomendação usa o texto final (revisado) como resumo. */
function modelMessageRecommendation(state, text) {
  const facts = recall(state).message;
  // Sem resumo de verdade (mensagem enviada pela empresa ou resposta de insuficiência de fontes), nada vira recomendação.
  if (!facts || facts.outbound || String(text || '').includes(MENSAGEM_INSUFICIENCIA)) return null;
  const resumo = String(text || '').replace(/\s*\[\d+\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 900);
  return messageRecommendation(facts, resumo, 'MODEL');
}

/** Gancho de resposta (agentHooks.checkAnswer): cria a recomendação da capacidade e a devolve em `proposals` do run. O texto não muda. */
async function recommendNextAction(state, text) {
  const meta = state.ruleMeta || {};
  if (meta.recommendation) { await save(state, meta.recommendation); return text; }
  if (state.parsed.taskType === TASKS.MESSAGE_SUMMARY && state.decision && state.decision.path !== 'RULE') {
    const rec = modelMessageRecommendation(state, text);
    if (rec) await save(state, rec);
    return text;
  }
  if (state.parsed.taskType !== TASKS.NEXT_ACTION) return text;
  const opportunityId = targetOf(state);
  if (!opportunityId) return text;
  await save(state, {
    type: TYPE, entityType: ENTITY, entityId: opportunityId, riskLevel: 'LOW', title: (meta.title || firstLine(text) || 'Próxima ação sugerida').slice(0, 200),
    rationale: meta.rationale || firstLine(text), payload: { rule: meta.rule || null, matched: meta.matched || [], source: meta.rule ? 'RULE' : 'MODEL' },
  });
  return text;
}

module.exports = { recommendNextAction, TYPE, ENTITY };
