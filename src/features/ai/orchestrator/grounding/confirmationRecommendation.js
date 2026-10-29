'use strict';

// M9-D025 item 7 — a confirmação humana de prazo/contrato crítico é uma recomendação REQUIRES_CONFIRMATION (serviço da M9-D007),
// SEM ação proposta, dirigida a quem tem legal:read. A pessoa a aceita como "vista" com ai:read; nenhuma tarefa é criada e a NAY
// não decide nada. A duplicidade (mesmo agente, contrato, tipo e dia, ainda pendente) devolve a mesma recomendação.

const recommendations = require('../../recommendations');
const { listUsersWithPermission } = require('../../readmodels/legalReaders.readmodel');
const C = require('./grounding.constants');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Destinatário: quem perguntou, se tem legal:read; senão a primeira pessoa da empresa com legal:read; senão quem perguntou (sinalizado). */
async function resolveTarget(ctx, transaction) {
  const readers = await listUsersWithPermission(ctx, C.PERMISSAO_JURIDICO, transaction);
  if (ctx.userId && readers.includes(ctx.userId)) return { userId: ctx.userId, noLegalReader: false };
  if (readers.length) return { userId: readers[0], noLegalReader: false };
  return { userId: ctx.userId || null, noLegalReader: true };
}

async function createConfirmationRecommendation(ctx, { runId, agentCode, request, snapshotAt, groundingStatus }, transaction) {
  const target = await resolveTarget(ctx, transaction);
  const byContract = UUID.test(String(request.contractRef || ''));
  const { recommendation, replayed } = await recommendations.createRecommendation(ctx, {
    agentCode: agentCode || 'NAY', aiRunId: runId, relatedEntityType: byContract ? 'LEGAL_CONTRACT' : 'AI_RUN',
    relatedEntityId: byContract ? request.contractRef : runId, recommendationType: C.TIPO_RECOMENDACAO_CONFIRMACAO,
    title: 'Confirmar prazo ou contrato antes de agir', rationale: `${C.MENSAGEM_CONFIRMACAO_HUMANA} Fonte: ${request.title}, versão ${request.version}, cláusula ${request.clause}.`,
    riskLevel: 'HIGH', targetUserId: target.userId,
    payload: { contract: request.title, version: request.version, clause: request.clause, sourceRefs: request.sourceRefs, snapshotAt, groundingStatus, noLegalReader: target.noLegalReader },
  }, transaction);
  return { id: recommendation.id, targetUserId: recommendation.targetUserId || target.userId, replay: replayed };
}

module.exports = { createConfirmationRecommendation };
